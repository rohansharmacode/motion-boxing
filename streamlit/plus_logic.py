"""Pure logic for the "Snowflake Lab" page (streamlit/pages/1_Snowflake_Lab.py).

No Streamlit or Snowflake imports, so everything here is unit-tested in
``streamlit/tests/test_plus_logic.py``. Object and column names follow
``sql/PLUS_CONTRACT.md``. Covers:

* Cortex Analyst: request body, conversation history, response parsing,
  read-only SQL check, auto chart choice, canned DEMO answers;
* Cortex Search: JSON argument + escaped SQL string literal, result parsing;
* style vectors (same formulas as PLAYER_FORM.form_score), twins, scouting (DEMO);
* SESSION_SUMMARY / PLAYER_PROGRESS shaping and REGR_SLOPE;
* punch heatmap shaping, time-machine leaderboard ranking;
* deterministic DEMO frames for every Lab section, built from logic.build_demo_dataset().

Python 3.9 compatible.
"""
from __future__ import annotations

import json
import math
import re
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import pandas as pd

import logic as L

# ---------------------------------------------------------------------------
# Constants (names from sql/PLUS_CONTRACT.md)
# ---------------------------------------------------------------------------
PUNCH_TYPES = list(L.PUNCH_TYPES)
STYLE_COMPONENTS = ["speed", "reaction", "accuracy", "guard", "symmetry", "endurance"]
STYLE_LABELS = {
    "speed": "Speed", "reaction": "Reaction", "accuracy": "Accuracy",
    "guard": "Guard", "symmetry": "Symmetry", "endurance": "Endurance",
}
FIGHTING_STYLES = ["Out-boxer", "Swarmer", "Slugger", "Boxer-puncher", "Counter-puncher"]
DRILL_FOCUS = ["speed", "reaction", "accuracy", "guard", "symmetry", "endurance", "combos", "footwork"]
HIGHLIGHT_KINDS = ["speed_record", "reaction_record", "personal_best_speed", "punch_milestone", "suspicious_speed"]
HIGHLIGHT_ICONS = {
    "speed_record": "⚡",          # high voltage
    "reaction_record": "⏱️",  # stopwatch
    "personal_best_speed": "\U0001f3c5",  # medal
    "punch_milestone": "\U0001f94a",   # boxing glove
    "suspicious_speed": "\U0001f6a9",  # red flag (anti-cheat)
}
HIGHLIGHT_LABELS = {
    "speed_record": "Speed record", "reaction_record": "Reaction record",
    "personal_best_speed": "Personal best", "punch_milestone": "Milestone",
    "suspicious_speed": "Anti-cheat flag",
}
DEFAULT_ICON = "•"
EMPTY = "n/a"  # missing values in the Lab UI (no em dashes)

ANALYST_ENDPOINT = "/api/v2/cortex/analyst/message"
SEMANTIC_MODEL_FILE = "@MOTION_DB.PUBLIC.SEMANTIC_MODELS/motion_boxing.yaml"
ANALYST_TIMEOUT_MS = 50000
MAX_HISTORY_TURNS = 4  # user+analyst pairs kept in the request

SEARCH_SERVICE = "MOTION_DB.PUBLIC.COACH_DRILL_SEARCH"
SEARCH_COLUMNS = ["drill_id", "title", "focus", "level", "description", "cues"]
MAX_SEARCH_CHARS = 200

MAX_TIME_TRAVEL_MIN = 60
HEATMAP_BUCKET_S = 10
HEATMAP_MAX_BUCKETS = 18  # a round is 180 s

CROWD_INSTRUCTION = ("These are coach summaries of recent boxing rounds by different players. "
                     "List the 3 most common weaknesses across these boxers and one drill for the whole room. "
                     "Answer in under 120 words, as a short list.")
# Model for the AI_COMPLETE fallback (allow-listed literal). mistral-large2 and
# llama3.1-70b went legacy on 2026-08-12 and fail on new accounts. Alternatives: llama3.3-70b, claude-sonnet-4-6.
CROWD_MODEL = "mistral-large3"

# Pro reference used for the style chart when PRO_BENCHMARKS has no pro_avg row.
_PRO_METRIC_COL = {
    "punch_speed_mps": "avg_speed", "reaction_ms": "avg_reaction_ms", "accuracy_pct": "accuracy_pct",
    "guard_pct": "guard_pct", "symmetry_pct": "symmetry_pct", "fatigue_drop_pct": "fatigue_drop_pct",
}


# ---------------------------------------------------------------------------
# SQL literal escaping (only for the constant argument of SEARCH_PREVIEW / AI_AGG)
# ---------------------------------------------------------------------------
_CTRL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def sql_string_literal(text: Any) -> str:
    """Single-quoted Snowflake string literal. Escapes backslashes first, then quotes.

    In Snowflake single-quoted strings the backslash is an escape character, so a
    raw backslash must become ``\\\\`` and a quote becomes ``''``. NUL and other
    control characters are dropped.
    """
    s = _CTRL_RE.sub("", "" if text is None else str(text))
    s = s.replace("\\", "\\\\").replace("'", "''")
    return "'" + s + "'"


def build_search_json(query: Any, focus: Optional[str] = None, limit: int = 3) -> str:
    """JSON argument for SNOWFLAKE.CORTEX.SEARCH_PREVIEW (ASCII only, compact)."""
    q = L.sanitize_question(query, MAX_SEARCH_CHARS)
    body: Dict[str, Any] = {"query": q, "columns": list(SEARCH_COLUMNS), "limit": int(L.clamp(int(limit), 1, 10))}
    if focus and focus in DRILL_FOCUS:  # allow-listed, never free text
        body["filter"] = {"@eq": {"focus": focus}}
    return json.dumps(body, ensure_ascii=True, separators=(",", ":"))


def search_preview_sql(query: Any, focus: Optional[str] = None, limit: int = 3) -> str:
    return "SELECT SNOWFLAKE.CORTEX.SEARCH_PREVIEW({}, {}) AS result".format(
        sql_string_literal(SEARCH_SERVICE), sql_string_literal(build_search_json(query, focus, limit)))


def parse_search_results(raw: Any) -> pd.DataFrame:
    """SEARCH_PREVIEW returns {"results": [...]} as an OBJECT or a JSON string (depends on version)."""
    data = raw
    if isinstance(raw, (str, bytes)):
        try:
            data = json.loads(raw)
        except ValueError:
            data = {}
    rows = (data or {}).get("results") if isinstance(data, dict) else None
    rows = rows if isinstance(rows, list) else []
    out = []
    for r in rows:
        if isinstance(r, dict):
            lower = {str(k).lower(): v for k, v in r.items()}
            out.append({c: lower.get(c) for c in SEARCH_COLUMNS})
    return pd.DataFrame(out, columns=SEARCH_COLUMNS)


# ---------------------------------------------------------------------------
# Errors -> short, actionable messages
# ---------------------------------------------------------------------------
_MISSING_PATTERNS = ("does not exist", "not authorized", "unknown function", "invalid identifier",
                     "insufficient privileges", "unknown user-defined function", "not found")


def classify_error(exc: Any) -> str:
    """'time_travel' | 'missing' | 'other'."""
    text = str(exc).lower()
    if "time travel data is not available" in text or "beyond the allowed time travel" in text:
        return "time_travel"
    if any(p in text for p in _MISSING_PATTERNS):
        return "missing"
    return "other"


def short_error(exc: Any, limit: int = 180) -> str:
    text = " ".join(str(exc).split())
    name = type(exc).__name__ if isinstance(exc, BaseException) else "Error"
    return "{}: {}".format(name, text[:limit])


# ---------------------------------------------------------------------------
# Value helpers
# ---------------------------------------------------------------------------
def _f(v: Any) -> Optional[float]:
    return L.to_float(v)


def clamp100(x: Optional[float]) -> Optional[float]:
    if x is None:
        return None
    return L.clamp(x, 0.0, 100.0)


# ---------------------------------------------------------------------------
# Cortex Analyst
# ---------------------------------------------------------------------------
def user_message(question: str) -> Dict[str, Any]:
    return {"role": "user", "content": [{"type": "text", "text": question}]}


def trim_history(messages: Sequence[Mapping[str, Any]], max_turns: int = MAX_HISTORY_TURNS) -> List[Dict[str, Any]]:
    """Keep the last complete user/analyst pairs, strictly alternating, starting with user."""
    pairs: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
    i = 0
    msgs = [dict(m) for m in messages if isinstance(m, Mapping)]
    while i + 1 < len(msgs):
        if msgs[i].get("role") == "user" and msgs[i + 1].get("role") == "analyst":
            pairs.append((msgs[i], msgs[i + 1]))
            i += 2
        else:
            i += 1
    out: List[Dict[str, Any]] = []
    for u, a in pairs[-max_turns:] if max_turns > 0 else []:
        out += [u, a]
    return out


def build_analyst_body(history: Sequence[Mapping[str, Any]], question: str,
                       semantic_model_file: str = SEMANTIC_MODEL_FILE) -> Dict[str, Any]:
    msgs = trim_history(history)
    msgs.append(user_message(question))
    return {"messages": msgs, "semantic_model_file": semantic_model_file, "stream": False}


def parse_analyst_response(resp: Any) -> Dict[str, Any]:
    """Parse the dict returned by _snowflake.send_snow_api_request.

    Returns {ok, status, text, sql, confidence, suggestions, warnings, message, error, request_id}.
    Unknown content types are ignored.
    ``message`` is the analyst message to append to the history (only when ok).
    """
    out: Dict[str, Any] = {"ok": False, "status": None, "text": "", "sql": None, "confidence": None,
                           "suggestions": [], "message": None, "error": None, "request_id": None, "warnings": []}
    if not isinstance(resp, Mapping):
        out["error"] = "Empty response from Cortex Analyst."
        return out
    try:
        status = int(resp.get("status")) if resp.get("status") is not None else 200
    except (TypeError, ValueError):
        status = None
    out["status"] = status
    content = resp.get("content")
    if isinstance(content, (bytes, bytearray)):
        content = content.decode("utf-8", "replace")
    if isinstance(content, str):
        try:
            content = json.loads(content) if content.strip() else {}
        except ValueError:
            content = {"message": content}
    if not isinstance(content, Mapping):
        content = {}
    out["request_id"] = content.get("request_id")
    if status is None or status >= 400 or status != 200 and "message" not in content:
        msg = content.get("message") if isinstance(content.get("message"), str) else None
        code = content.get("error_code") or content.get("code")
        out["error"] = "Cortex Analyst returned {}: {}{}".format(
            status if status is not None else "an error", msg or "no message",
            " ({})".format(code) if code else "")
        return out
    message = content.get("message")
    if not isinstance(message, Mapping):
        out["error"] = "Cortex Analyst response had no message."
        return out
    texts: List[str] = []
    for item in message.get("content") or []:
        if not isinstance(item, Mapping):
            continue
        kind = item.get("type")
        if kind == "text" and item.get("text"):
            texts.append(str(item["text"]))
        elif kind == "sql" and item.get("statement"):
            out["sql"] = str(item["statement"])
            out["confidence"] = item.get("confidence")
        elif kind == "suggestions":
            out["suggestions"] = [str(s) for s in (item.get("suggestions") or []) if s]
    out["warnings"] = [str(w.get("message")) for w in (content.get("warnings") or [])
                       if isinstance(w, Mapping) and w.get("message")]
    out["text"] = "\n\n".join(texts)
    out["message"] = {"role": "analyst", "content": list(message.get("content") or [])}
    out["ok"] = True
    return out


def verified_query_used(confidence: Any) -> Optional[str]:
    if isinstance(confidence, Mapping):
        vq = confidence.get("verified_query_used")
        if isinstance(vq, Mapping):
            return str(vq.get("name") or vq.get("question") or "verified query")
    return None


_SQL_COMMENT_RE = re.compile(r"(--[^\n]*)|(/\*.*?\*/)", re.S)


def runnable_sql(statement: Any) -> str:
    """Analyst SQL with trailing ';' removed, so Snowpark can wrap it in a subquery (.limit()).
    Comments are kept: Snowpark puts a newline before the closing ')', so a trailing -- comment is safe."""
    s = str(statement or "").strip()
    while s.endswith(";"):
        s = s[:-1].rstrip()
    return s


def is_read_only_sql(statement: Any) -> bool:
    """True for a single SELECT / WITH statement (Analyst output is run only then)."""
    if not statement or not isinstance(statement, str):
        return False
    s = _SQL_COMMENT_RE.sub(" ", statement).strip().rstrip(";").strip()
    if not s or ";" in s:
        return False
    return bool(re.match(r"^(select|with)\b", s, re.I))


def _is_temporal(col: pd.Series) -> bool:
    if pd.api.types.is_datetime64_any_dtype(col):
        return True
    vals = col.dropna()
    return len(vals) > 0 and all(isinstance(v, (date, datetime, pd.Timestamp)) for v in vals.head(50))


def _coerce_numeric(col: pd.Series) -> Optional[pd.Series]:
    if pd.api.types.is_bool_dtype(col):
        return None
    if pd.api.types.is_numeric_dtype(col):
        return col
    vals = col.dropna()
    if len(vals) and all(isinstance(v, (int, float, Decimal)) and not isinstance(v, bool) for v in vals.head(50)):
        return pd.to_numeric(col, errors="coerce")
    return None


def auto_chart_spec(df: Optional[pd.DataFrame], max_rows: int = 200) -> Optional[Dict[str, Any]]:
    """Pick x/y for a simple chart: one categorical or time column + one numeric column.

    Returns {x, y, kind: 'bar'|'line', data} or None.
    """
    if df is None or df.empty or len(df.columns) < 2 or len(df) > max_rows:
        return None
    data = df.copy()
    time_cols, cat_cols, num_cols = [], [], []
    for c in data.columns:
        col = data[c]
        if _is_temporal(col):
            time_cols.append(c)
            continue
        num = _coerce_numeric(col)
        if num is not None:
            data[c] = num
            num_cols.append(c)
        else:
            cat_cols.append(c)
    if not num_cols or not (time_cols or cat_cols):
        return None
    if time_cols:
        x = time_cols[0]
        data[x] = pd.to_datetime(data[x], errors="coerce")
        kind = "line"
    else:
        x = cat_cols[0]
        data[x] = data[x].astype(str)
        kind = "bar"
    y = num_cols[0]
    return {"x": x, "y": y, "kind": kind, "data": data[[x, y]].dropna()}


# --- canned answers for DEMO mode / outside SiS -------------------------------
# Same questions (and verified query names) as sql/semantic_model/motion_boxing.yaml.
DEMO_QUESTIONS = [
    "Who are the top 5 players by best score?",
    "Which punch type is the fastest on average?",
    "How many rounds were played each day?",
]
_DEMO_VQ = {0: "top_5_players_by_best_score", 1: "fastest_punch_type_on_average", 2: "rounds_played_per_day"}


def _norm_q(q: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", str(q).lower()).split())


def _demo_pick(q: str) -> Optional[int]:
    if "best score" in q or ("top" in q and "player" in q):
        return 0
    if "type" in q and ("fast" in q or "speed" in q):
        return 1
    if "day" in q or "daily" in q:
        return 2
    return None


def demo_analyst_answer(question: str, ds: Mapping[str, Any]) -> Tuple[Dict[str, Any], Optional[pd.DataFrame]]:
    """(response dict in the send_snow_api_request shape, result frame) for DEMO mode."""
    q = _norm_q(question)
    ev = ds["events"]
    punches = ev[ev["event_type"].isin(PUNCH_TYPES)]
    sess = ds["sessions"].merge(ds["players"][["player_id", "name"]], on="player_id", how="left")
    pick = _demo_pick(q)
    sql, df, text = None, None, None
    if pick == 0:
        df = (sess.groupby(["player_id", "name"]).agg(best_score=("score", "max"), rounds_played=("session_id", "nunique"))
              .reset_index().sort_values("best_score", ascending=False).head(5)[["name", "best_score", "rounds_played"]]
              .reset_index(drop=True))
        sql = ("SELECT pl.name, MAX(s.score) AS best_score, COUNT(DISTINCT s.session_id) AS rounds_played\n"
               "FROM MOTION_DB.PUBLIC.SESSION_SUMMARY AS s\nJOIN MOTION_DB.PUBLIC.PLAYERS AS pl ON s.player_id = pl.player_id\n"
               "GROUP BY pl.player_id, pl.name\nORDER BY best_score DESC NULLS LAST\nLIMIT 5")
        text = "These are the top 5 players by their best single-round score. {} leads with {:,.0f}.".format(
            df.iloc[0]["name"], float(df.iloc[0]["best_score"]))
    elif pick == 1:
        df = (punches.groupby("event_type").agg(avg_speed_mps=("speed_mps", "mean"), punches_thrown=("event_id", "count"))
              .reset_index().rename(columns={"event_type": "punch_type"}).sort_values("avg_speed_mps", ascending=False)
              .reset_index(drop=True))
        df["avg_speed_mps"] = df["avg_speed_mps"].round(2)
        sql = ("SELECT LOWER(event_type) AS punch_type, ROUND(AVG(speed_mps), 2) AS avg_speed_mps, "
               "COUNT(*) AS punches_thrown\nFROM MOTION_DB.PUBLIC.MOTION_EVENTS\n"
               "WHERE LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut')\nGROUP BY 1\n"
               "ORDER BY avg_speed_mps DESC NULLS LAST")
        text = "This is the average speed per punch type. The {} is fastest at {:.2f} m/s.".format(
            df.iloc[0]["punch_type"], float(df.iloc[0]["avg_speed_mps"]))
    elif pick == 2:
        tmp = sess.assign(play_date=pd.to_datetime(sess["started_at"]).dt.normalize())
        df = (tmp.groupby("play_date").agg(rounds_played=("session_id", "nunique"), players=("player_id", "nunique"))
              .reset_index().sort_values("play_date", ascending=False).reset_index(drop=True))
        sql = ("SELECT DATE_TRUNC('DAY', session_start_ts) AS play_date, COUNT(DISTINCT session_id) AS rounds_played, "
               "COUNT(DISTINCT player_id) AS players\nFROM MOTION_DB.PUBLIC.SESSION_SUMMARY\n"
               "GROUP BY play_date\nORDER BY play_date DESC")
        text = "This is the number of rounds played per day."
    content: List[Dict[str, Any]] = []
    if pick is None:
        content.append({"type": "text", "text": "In DEMO mode I can answer three example questions. "
                                                "Connect to Snowflake for free-form questions."})
        content.append({"type": "suggestions", "suggestions": list(DEMO_QUESTIONS)})
    else:
        content.append({"type": "text", "text": text})
        content.append({"type": "sql", "statement": sql, "confidence": {"verified_query_used": {
            "name": _DEMO_VQ[pick], "question": DEMO_QUESTIONS[pick]}}})
        content.append({"type": "suggestions", "suggestions": [s for i, s in enumerate(DEMO_QUESTIONS) if i != pick][:2]})
    resp = {"status": 200, "content": json.dumps({"message": {"role": "analyst", "content": content},
                                                  "request_id": "demo", "warnings": []})}
    return resp, df


# ---------------------------------------------------------------------------
# Style vectors (PLUS_CONTRACT "Style vector convention")
# ---------------------------------------------------------------------------
def style_components(row: Optional[Mapping[str, Any]]) -> Dict[str, float]:
    """0..100 per component; NULL -> 50, using the PLAYER_FORM.form_score formulas."""
    row = row or {}
    speed, react = _f(row.get("avg_speed")), _f(row.get("avg_reaction_ms"))
    acc, guard = _f(row.get("accuracy_pct")), _f(row.get("guard_pct"))
    sym, drop = _f(row.get("symmetry_pct")), _f(row.get("fatigue_drop_pct"))
    raw = {
        "speed": None if speed is None else speed / 10 * 100,
        "reaction": None if react is None else (500 - react) / 320 * 100,
        "accuracy": acc,
        "guard": guard,
        "symmetry": sym,
        "endurance": None if drop is None else 100 - 2 * drop,
    }
    return {k: round(50.0 if v is None else float(clamp100(v)), 1) for k, v in raw.items()}


def style_vector(components: Mapping[str, Any]) -> List[float]:
    return [(_f(components.get(k)) if _f(components.get(k)) is not None else 50.0) / 100 - 0.5
            for k in STYLE_COMPONENTS]


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> Optional[float]:
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return None
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def similarity_pct(sim: Optional[float]) -> Optional[float]:
    return None if sim is None else round(50 * (sim + 1), 1)


def pro_components(benchmarks: Optional[pd.DataFrame]) -> Dict[str, float]:
    """Pro style components from PRO_BENCHMARKS.pro_avg (falls back to the seeded values)."""
    row: Dict[str, Any] = {}
    bench = L.normalize_columns(benchmarks) if benchmarks is not None else pd.DataFrame()
    if not bench.empty and {"metric", "pro_avg"}.issubset(bench.columns):
        for r in bench.to_dict("records"):
            col = _PRO_METRIC_COL.get(str(r.get("metric")))
            if col:
                row[col] = r.get("pro_avg")
    for b in L.DEMO_BENCHMARKS:
        row.setdefault(_PRO_METRIC_COL[b[1]], b[6])
    return style_components(row)


def style_frame(player: Optional[Mapping[str, Any]], pro: Mapping[str, float]) -> pd.DataFrame:
    """Long frame for the 6-component chart: component, label, value, pro."""
    player = player or {}
    rows = []
    for k in STYLE_COMPONENTS:
        v = _f(player.get("c_" + k))
        if v is None:
            v = _f(player.get(k))
        rows.append({"component": k, "label": STYLE_LABELS[k], "value": v, "pro": _f(pro.get(k))})
    return pd.DataFrame(rows)


def _style_row(form_row: Mapping[str, Any], pro_vec: Sequence[float]) -> Dict[str, Any]:
    comps = style_components(form_row)
    vec = style_vector(comps)
    out: Dict[str, Any] = {"player_id": form_row.get("player_id"), "name": form_row.get("name")}
    out.update({"c_" + k: comps[k] for k in STYLE_COMPONENTS})
    out["style_vec"] = vec
    out["pro_similarity_pct"] = similarity_pct(cosine_similarity(vec, pro_vec))
    return out


def demo_player_style(player_form: pd.DataFrame, benchmarks: Optional[pd.DataFrame]) -> pd.DataFrame:
    pro_vec = style_vector(pro_components(benchmarks))
    rows = [_style_row(r, pro_vec) for r in player_form.to_dict("records") if (_f(r.get("punches")) or 0) > 0]
    return pd.DataFrame(rows)


def style_twins(style_df: pd.DataFrame) -> pd.DataFrame:
    """Nearest OTHER player by cosine similarity (V_STYLE_TWINS columns)."""
    rows = style_df.to_dict("records")
    out = []
    for r in rows:
        best = None
        for o in rows:
            if o["player_id"] == r["player_id"]:
                continue
            sim = cosine_similarity(r["style_vec"], o["style_vec"])
            if sim is not None and (best is None or sim > best[0] or (sim == best[0] and o["player_id"] < best[1]["player_id"])):
                best = (sim, o)
        if best:
            out.append({"player_id": r["player_id"], "name": r["name"], "twin_player_id": best[1]["player_id"],
                        "twin_name": best[1]["name"], "similarity": round(best[0], 4),
                        "similarity_pct": similarity_pct(best[0])})
    return pd.DataFrame(out, columns=["player_id", "name", "twin_player_id", "twin_name", "similarity", "similarity_pct"])


def classify_style(c: Mapping[str, float]) -> str:
    """Rule-based stand-in for AI_CLASSIFY in DEMO mode."""
    if c["guard"] >= 70 and c["accuracy"] >= 65 and c["speed"] < 75:
        return "Out-boxer"
    if c["speed"] >= 75 and c["accuracy"] >= 65:
        return "Boxer-puncher"
    if c["reaction"] >= 60 and c["guard"] >= 60:
        return "Counter-puncher"
    if c["speed"] >= 65 and c["guard"] < 60:
        return "Swarmer"
    return "Slugger"


def demo_scouting(style_df: pd.DataFrame, player_form: pd.DataFrame, now: datetime) -> pd.DataFrame:
    form = {r["player_id"]: r for r in player_form.to_dict("records")}
    out = []
    for r in style_df.to_dict("records"):
        comps = {k: float(r["c_" + k]) for k in STYLE_COMPONENTS}
        style = classify_style(comps)
        best = max(STYLE_COMPONENTS, key=lambda k: comps[k])
        worst = min(STYLE_COMPONENTS, key=lambda k: comps[k])
        report = ("{} boxes like a {}: {} is the best asset ({:.0f}/100) and {} is the biggest gap ({:.0f}/100). "
                  "Next block of training should target {}.").format(
            r["name"], style.lower(), STYLE_LABELS[best].lower(), comps[best], STYLE_LABELS[worst].lower(),
            comps[worst], STYLE_LABELS[worst].lower())
        f = form.get(r["player_id"], {})
        out.append({"player_id": r["player_id"], "name": r["name"], "fighting_style": style,
                    "scouting_report": report, "punches_at_scan": f.get("punches"),
                    "form_score_at_scan": f.get("form_score"), "updated_at": now - timedelta(minutes=3)})
    return pd.DataFrame(out)


# ---------------------------------------------------------------------------
# SESSION_SUMMARY / PLAYER_PROGRESS
# ---------------------------------------------------------------------------
def regr_slope(xs: Sequence[Any], ys: Sequence[Any]) -> Optional[float]:
    """Snowflake REGR_SLOPE(y, x): pairs with a NULL are ignored; None if < 2 pairs or no x variance."""
    pts = [(_f(x), _f(y)) for x, y in zip(xs, ys)]
    pts = [(x, y) for x, y in pts if x is not None and y is not None]
    if len(pts) < 2:
        return None
    mx = sum(x for x, _ in pts) / len(pts)
    my = sum(y for _, y in pts) / len(pts)
    sxx = sum((x - mx) ** 2 for x, _ in pts)
    if sxx == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in pts) / sxx


SUMMARY_COLUMNS = ["player_id", "session_id", "session_start_ts", "session_index", "score", "punches",
                   "avg_speed", "max_speed", "avg_reaction_ms", "accuracy_pct", "guard_pct"]


def session_summary_from_events(events: pd.DataFrame) -> pd.DataFrame:
    """Same semantics as the SESSION_SUMMARY dynamic table (pipelines.sql)."""
    if events is None or events.empty:
        return pd.DataFrame(columns=SUMMARY_COLUMNS)
    ev = events[events["player_id"].notna()].copy()
    ev["is_punch"] = ev["event_type"].str.lower().isin(PUNCH_TYPES)
    g = ev.groupby(["player_id", "session_id"])
    base = g.agg(session_start_ts=("event_ts", "min"), score=("points", lambda s: float(s.fillna(0).sum())))
    p = ev[ev["is_punch"]].groupby(["player_id", "session_id"]).agg(
        punches=("event_type", "size"), avg_speed=("speed_mps", "mean"), max_speed=("speed_mps", "max"),
        avg_reaction_ms=("reaction_ms", "mean"), accuracy=("accuracy", "mean"),
        guard=("guard_up", lambda s: float(pd.Series(s, dtype="float").mean())))
    out = base.join(p, how="left").reset_index()
    out["punches"] = out["punches"].fillna(0).astype(int)
    out["accuracy_pct"] = (out["accuracy"] * 100).round(1)
    out["guard_pct"] = (out["guard"] * 100).round(1)
    out["avg_speed"] = out["avg_speed"].round(2)
    out["max_speed"] = out["max_speed"].round(2)
    out["avg_reaction_ms"] = out["avg_reaction_ms"].round(1)
    out = out.sort_values(["player_id", "session_start_ts", "session_id"])
    out["session_index"] = out.groupby("player_id").cumcount() + 1
    return out[SUMMARY_COLUMNS].reset_index(drop=True)


PROGRESS_COLUMNS = ["player_id", "sessions", "first_session_ts", "last_session_ts", "best_score", "last_score",
                    "speed_trend_mps_per_session", "score_trend_per_session", "accuracy_trend_pct_per_session",
                    "reaction_trend_ms_per_session", "improving"]


def progress_from_summary(summary: pd.DataFrame) -> pd.DataFrame:
    """Same semantics as the PLAYER_PROGRESS dynamic table."""
    rows = []
    if summary is None or summary.empty:
        return pd.DataFrame(columns=PROGRESS_COLUMNS)
    for pid, s in summary.sort_values("session_index").groupby("player_id"):
        idx = list(s["session_index"])
        score_trend = regr_slope(idx, list(s["score"]))
        rows.append({
            "player_id": pid, "sessions": int(len(s)),
            "first_session_ts": s["session_start_ts"].min(), "last_session_ts": s["session_start_ts"].max(),
            "best_score": _f(s["score"].max()), "last_score": _f(s["score"].iloc[-1]),
            "speed_trend_mps_per_session": regr_slope(idx, list(s["avg_speed"])),
            "score_trend_per_session": score_trend,
            "accuracy_trend_pct_per_session": regr_slope(idx, list(s["accuracy_pct"])),
            "reaction_trend_ms_per_session": regr_slope(idx, list(s["avg_reaction_ms"])),
            "improving": None if score_trend is None else bool(score_trend > 0),
        })
    return pd.DataFrame(rows, columns=PROGRESS_COLUMNS)


def trend_text(value: Any, unit: str, higher_is_better: bool = True, decimals: int = 1) -> Tuple[str, str]:
    """(value text, verdict) for a per-session trend number."""
    v = _f(value)
    if v is None:
        return EMPTY, "needs 2+ rounds"
    good = v > 0 if higher_is_better else v < 0
    sign = "+" if v > 0 else ""
    txt = "{}{:.{d}f} {}/round".format(sign, v, unit, d=decimals).replace(" /", "/")
    if abs(v) < 10 ** (-decimals):
        return txt, "flat"
    return txt, "improving" if good else "slipping"


# ---------------------------------------------------------------------------
# Punch heatmap
# ---------------------------------------------------------------------------
def heatmap_agg_from_events(events: pd.DataFrame, bucket_s: int = HEATMAP_BUCKET_S) -> pd.DataFrame:
    """(punch_type, bucket, punches, avg_speed); bucket = seconds since the session's first event // 10."""
    cols = ["punch_type", "bucket", "punches", "avg_speed"]
    if events is None or events.empty:
        return pd.DataFrame(columns=cols)
    ev = events.copy()
    ts = pd.to_datetime(ev["event_ts"])
    t0 = ts.groupby(ev["session_id"]).transform("min")
    ev["bucket"] = ((ts - t0).dt.total_seconds() // bucket_s).astype(int)
    ev["punch_type"] = ev["event_type"].str.lower()
    ev = ev[ev["punch_type"].isin(PUNCH_TYPES)]
    return (ev.groupby(["punch_type", "bucket"]).agg(punches=("punch_type", "size"), avg_speed=("speed_mps", "mean"))
            .reset_index()[cols])


def shape_heatmap(agg: Optional[pd.DataFrame], bucket_s: int = HEATMAP_BUCKET_S,
                  max_buckets: int = HEATMAP_MAX_BUCKETS) -> pd.DataFrame:
    """Full punch_type x bucket grid (missing cells: 0 punches, avg_speed NaN), with labels."""
    agg = L.normalize_columns(agg)
    cols = ["punch_type", "bucket", "bucket_label", "punches", "avg_speed"]
    if agg.empty or not {"punch_type", "bucket"}.issubset(agg.columns):
        return pd.DataFrame(columns=cols)
    agg = agg.copy()
    agg["punch_type"] = agg["punch_type"].astype(str).str.lower()
    agg["bucket"] = pd.to_numeric(agg["bucket"], errors="coerce")
    agg = agg[agg["punch_type"].isin(PUNCH_TYPES) & agg["bucket"].notna() & (agg["bucket"] >= 0)]
    if agg.empty:
        return pd.DataFrame(columns=cols)
    agg["bucket"] = agg["bucket"].astype(int).clip(upper=max_buckets - 1)  # late events fold into the last bucket
    agg["punches"] = pd.to_numeric(agg.get("punches"), errors="coerce").fillna(0)
    agg["avg_speed"] = pd.to_numeric(agg.get("avg_speed"), errors="coerce")
    agg["speed_x_n"] = agg["avg_speed"].fillna(0) * agg["punches"]
    g = agg.groupby(["punch_type", "bucket"]).agg(punches=("punches", "sum"), speed_x_n=("speed_x_n", "sum")).reset_index()
    n_buckets = int(g["bucket"].max()) + 1
    grid = pd.MultiIndex.from_product([PUNCH_TYPES, range(n_buckets)], names=["punch_type", "bucket"]).to_frame(index=False)
    out = grid.merge(g, on=["punch_type", "bucket"], how="left")
    out["punches"] = out["punches"].fillna(0).astype(int)
    out["avg_speed"] = (out["speed_x_n"] / out["punches"].where(out["punches"] > 0)).round(2)
    out["bucket_label"] = out["bucket"].map(lambda b: "{}-{} s".format(b * bucket_s, (b + 1) * bucket_s))
    return out[cols]


# ---------------------------------------------------------------------------
# Time machine
# ---------------------------------------------------------------------------
SESSION_SCORE_COLUMNS = ["player_id", "session_id", "score", "fastest_punch", "best_reaction_ms"]


def session_scores_from_events(events: pd.DataFrame) -> pd.DataFrame:
    """Per (player, session): SUM(points), fastest punch, best reaction (V_LEADERBOARD inputs)."""
    if events is None or events.empty:
        return pd.DataFrame(columns=SESSION_SCORE_COLUMNS)
    ev = events[events["player_id"].notna()].copy()
    ev["is_punch"] = ev["event_type"].str.lower().isin(PUNCH_TYPES)
    ev["punch_speed"] = ev["speed_mps"].where(ev["is_punch"])
    ev["react"] = ev["reaction_ms"].where(ev["reaction_ms"] > 0)
    out = ev.groupby(["player_id", "session_id"]).agg(
        score=("points", lambda s: float(s.fillna(0).sum())), fastest_punch=("punch_speed", "max"),
        best_reaction_ms=("react", "min")).reset_index()
    return out[SESSION_SCORE_COLUMNS]


def rank_time_machine(session_scores: Optional[pd.DataFrame], players: Optional[pd.DataFrame],
                      limit: int = 10) -> pd.DataFrame:
    """Same rule as V_LEADERBOARD: best session score, ties by fastest punch, best reaction, player_id."""
    cols = ["rank", "player_id", "name", "best_score", "fastest_punch", "best_reaction_ms"]
    s = L.normalize_columns(session_scores)
    if s.empty or "player_id" not in s.columns:
        return pd.DataFrame(columns=cols)
    for c in ("score", "fastest_punch", "best_reaction_ms"):
        s[c] = pd.to_numeric(s[c], errors="coerce") if c in s.columns else float("nan")
    s["player_id"] = s["player_id"].astype(str)
    per = s.groupby("player_id").agg(best_score=("score", "max"), fastest_punch=("fastest_punch", "max"),
                                     best_reaction_ms=("best_reaction_ms", "min")).reset_index()
    names: Dict[str, str] = {}
    p = L.normalize_columns(players)
    if not p.empty and {"player_id", "name"}.issubset(p.columns):
        names = dict(zip(p["player_id"].astype(str), p["name"].fillna("Unknown").astype(str)))
    per["name"] = per["player_id"].map(lambda x: names.get(x, "Unknown"))
    per = per.sort_values(["best_score", "fastest_punch", "best_reaction_ms", "player_id"],
                          ascending=[False, False, True, True], na_position="last").reset_index(drop=True)
    per["rank"] = range(1, len(per) + 1)
    return per[per["rank"] <= limit][cols].reset_index(drop=True)


def compare_leaderboards(now_lb: pd.DataFrame, then_lb: pd.DataFrame) -> pd.DataFrame:
    """Now leaderboard + rank_then and a movement label (up / down / new / same)."""
    out = now_lb.copy()
    then_rank = dict(zip(then_lb["player_id"], then_lb["rank"])) if not then_lb.empty else {}

    def move(r: Mapping[str, Any]) -> str:
        prev = then_rank.get(r["player_id"])
        if prev is None:
            return "new"
        d = int(prev) - int(r["rank"])
        return "up {}".format(d) if d > 0 else ("down {}".format(-d) if d < 0 else "same")

    out["rank_then"] = out["player_id"].map(lambda p: then_rank.get(p))
    out["movement"] = [move(r) for r in out.to_dict("records")] if not out.empty else []
    return out


def demo_retimed_events(events: pd.DataFrame, now: datetime, recent_sessions: int = 8,
                        window_min: int = MAX_TIME_TRAVEL_MIN) -> pd.DataFrame:
    """DEMO only: move the latest N sessions into the last hour so the time machine has something to show."""
    ev = events.copy()
    starts = ev.groupby("session_id")["event_ts"].min().sort_values()
    recent = list(starts.index[-recent_sessions:])
    step = timedelta(minutes=window_min / max(1, len(recent)))
    base = now - timedelta(minutes=window_min) + timedelta(minutes=1)
    for k, sid in enumerate(recent):
        mask = ev["session_id"] == sid
        shift = (base + step * k) - starts[sid]
        ev.loc[mask, "event_ts"] = ev.loc[mask, "event_ts"] + shift
    return ev


def events_as_of(events: pd.DataFrame, cutoff: datetime) -> pd.DataFrame:
    return events[pd.to_datetime(events["event_ts"]) <= pd.Timestamp(cutoff)]


def time_travel_offset_s(minutes: Any) -> int:
    """Validated negative offset in seconds for AT(OFFSET => ...): integer, 0..60 minutes."""
    try:
        m = int(minutes)
    except (TypeError, ValueError):
        m = 0
    return -60 * int(L.clamp(m, 0, MAX_TIME_TRAVEL_MIN))


# ---------------------------------------------------------------------------
# Highlights (DEMO stand-in for task T_HIGHLIGHTS)
# ---------------------------------------------------------------------------
HIGHLIGHT_COLUMNS = ["highlight_id", "created_at", "kind", "player_id", "name", "session_id", "value", "unit", "message"]
MILESTONES = (100, 250, 500, 1000)
SUSPICIOUS_SPEED_MPS = 15.0


def demo_highlights(events: pd.DataFrame, players: pd.DataFrame, limit: int = 50) -> pd.DataFrame:
    names = dict(zip(players["player_id"], players["name"]))
    ev = events[events["event_type"].isin(PUNCH_TYPES)].sort_values(["event_ts", "event_id"])
    rows: List[Dict[str, Any]] = []
    n = 0

    def add(kind: str, r: Mapping[str, Any], value: float, unit: str, msg: str) -> None:
        nonlocal n
        n += 1
        rows.append({"highlight_id": str(uuid.UUID(int=n, version=4)), "created_at": r["event_ts"] + timedelta(seconds=30),
                     "kind": kind, "player_id": r["player_id"], "name": names.get(r["player_id"], "Unknown"),
                     "session_id": r["session_id"], "value": round(float(value), 2), "unit": unit, "message": msg})

    best_speed, best_react = None, None
    pb: Dict[str, float] = {}
    counts: Dict[str, int] = {}
    seen = 0
    for r in ev.to_dict("records"):
        seen += 1
        pid, name = r["player_id"], names.get(r["player_id"], "Unknown")
        sp, rt = _f(r["speed_mps"]), _f(r["reaction_ms"])
        if sp is not None and sp > SUSPICIOUS_SPEED_MPS:
            add("suspicious_speed", r, sp, "m/s", "{:.1f} m/s by {} is above the {:.0f} m/s plausibility cap; flagged "
                "and kept out of records".format(sp, name, SUSPICIOUS_SPEED_MPS))
            continue
        if seen > 30 and sp is not None and (best_speed is None or sp > best_speed):
            add("speed_record", r, sp, "m/s", "New room speed record: {} hit {:.2f} m/s".format(name, sp))
        if seen > 30 and rt is not None and (best_react is None or rt < best_react):
            add("reaction_record", r, rt, "ms", "New room reaction record: {} reacted in {:.0f} ms".format(name, rt))
        if sp is not None:
            best_speed = sp if best_speed is None else max(best_speed, sp)
            if pid in pb and sp > pb[pid] + 0.5:
                add("personal_best_speed", r, sp, "m/s", "{} beat a personal best: {:.2f} m/s".format(name, sp))
            pb[pid] = sp if pid not in pb else max(pb[pid], sp)
        if rt is not None:
            best_react = rt if best_react is None else min(best_react, rt)
        counts[pid] = counts.get(pid, 0) + 1
        if counts[pid] in MILESTONES:
            add("punch_milestone", r, counts[pid], "punches", "{} has thrown {} punches".format(name, counts[pid]))
    # One synthetic anti-cheat example so the flag is visible in the demo (demo speeds are all plausible).
    if not any(x["kind"] == "suspicious_speed" for x in rows) and len(ev):
        last = ev.iloc[-1].to_dict()
        add("suspicious_speed", last, 18.4, "m/s", "18.4 m/s by {} is above the {:.0f} m/s plausibility cap; "
            "flagged and kept out of records".format(names.get(last["player_id"], "Unknown"), SUSPICIOUS_SPEED_MPS))
    out = pd.DataFrame(rows, columns=HIGHLIGHT_COLUMNS)
    return out.sort_values("created_at", ascending=False).head(limit).reset_index(drop=True)


def highlight_icon(kind: Any) -> str:
    return HIGHLIGHT_ICONS.get(str(kind or "").lower(), DEFAULT_ICON)


def shape_highlights(df: Optional[pd.DataFrame]) -> pd.DataFrame:
    """Newest first, with an icon + label column for display."""
    d = L.normalize_columns(df)
    if d.empty:
        return pd.DataFrame(columns=["icon", "kind_label"] + HIGHLIGHT_COLUMNS)
    for c in HIGHLIGHT_COLUMNS:
        if c not in d.columns:
            d[c] = None
    d = d.sort_values("created_at", ascending=False, na_position="last").reset_index(drop=True)
    d["icon"] = d["kind"].map(highlight_icon)
    d["kind_label"] = d["kind"].map(lambda k: HIGHLIGHT_LABELS.get(str(k or "").lower(), str(k or "")))
    return d[["icon", "kind_label"] + HIGHLIGHT_COLUMNS]


# ---------------------------------------------------------------------------
# Cortex Search (DEMO stand-in) and crowd coach (DEMO stand-in)
# ---------------------------------------------------------------------------
DEMO_DRILLS = [
    ("D01", "Chin-tuck shadow rounds", "guard", "beginner",
     "Three 1-minute rounds of shadow boxing with the rear glove touching the cheek after every punch.",
     "Glove to cheek; elbows in; exhale on each punch"),
    ("D02", "Jab-return ladder", "guard", "intermediate",
     "Throw a jab and bring it back to the guard before the next one; speed up every 20 seconds.",
     "Same path out and back; no dropping the hand"),
    ("D03", "Snap jab sprints", "speed", "beginner",
     "10 seconds of fast jabs, 20 seconds rest, 6 sets. Count punches per set.", "Relax the shoulder; snap, do not push"),
    ("D04", "Light-cue reactions", "reaction", "intermediate",
     "A partner or the game prompt calls a punch; throw it as fast as you can, 3 rounds of 1 minute.",
     "Stay loose; eyes on the cue"),
    ("D05", "Target focus pads", "accuracy", "beginner",
     "Pick one spot and land 20 clean straight punches before moving to the next spot.", "Slow is smooth; full extension"),
    ("D06", "Mirror switch drill", "symmetry", "intermediate",
     "Throw every combination twice: once orthodox, once southpaw, matching speed on both sides.",
     "Count both sides; lead with the weaker hand"),
    ("D07", "Last-30-seconds burnout", "endurance", "advanced",
     "Finish each round with 30 seconds of non-stop straight punches while keeping the guard up.",
     "Breathe out; keep the pace even"),
    ("D08", "1-2-3 flow", "combos", "beginner",
     "Jab, cross, lead hook in one rhythm, 5 sets of 10, return to guard after each set.", "Turn the hips on the cross"),
    ("D09", "Box-step footwork", "footwork", "beginner",
     "Step forward, right, back, left in a square while jabbing on each step.", "Small steps; never cross the feet"),
]


def demo_drill_search(query: Any, focus: Optional[str] = None, limit: int = 3) -> pd.DataFrame:
    words = set(_norm_q(L.sanitize_question(query, MAX_SEARCH_CHARS)).split())
    scored = []
    for d in DEMO_DRILLS:
        if focus and focus in DRILL_FOCUS and d[2] != focus:
            continue
        text = set(_norm_q(" ".join(d[1:])).split())
        scored.append((len(words & text), d))
    scored.sort(key=lambda x: (-x[0], x[1][0]))
    return pd.DataFrame([dict(zip(SEARCH_COLUMNS, d)) for _, d in scored[:limit]], columns=SEARCH_COLUMNS)


def demo_crowd_coach(style_df: pd.DataFrame) -> str:
    """Counts each player's weakest component (stand-in for AI_AGG in DEMO mode)."""
    if style_df is None or style_df.empty:
        return "No rounds to summarise yet."
    counts: Dict[str, int] = {}
    for r in style_df.to_dict("records"):
        weakest = min(STYLE_COMPONENTS, key=lambda k: float(r["c_" + k]))
        counts[weakest] = counts.get(weakest, 0) + 1
    ranked = sorted(STYLE_COMPONENTS, key=lambda k: (-counts.get(k, 0), STYLE_COMPONENTS.index(k)))[:3]
    lines = ["Most common weaknesses in the room:"]
    for i, k in enumerate(ranked, 1):
        lines.append("{}. {} (weakest area for {} of {} boxers)".format(i, STYLE_LABELS[k], counts.get(k, 0), len(style_df)))
    drill = next((d for d in DEMO_DRILLS if d[2] == ranked[0]), DEMO_DRILLS[0])
    lines.append("")
    lines.append("Drill for the whole room: {}. {}".format(drill[1], drill[4]))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# DEMO frames for Under the hood
# ---------------------------------------------------------------------------
def demo_refresh_history(now: datetime) -> pd.DataFrame:
    rows = []
    for i in range(6):
        for name, action in (("PLAYER_FORM", "INCREMENTAL"), ("SESSION_SUMMARY", "INCREMENTAL"),
                             ("PLAYER_PROGRESS", "INCREMENTAL" if i % 3 else "NO_DATA")):
            start = now - timedelta(minutes=i, seconds=40)
            rows.append({"name": name, "state": "SUCCEEDED", "refresh_action": action, "refresh_trigger": "SCHEDULED",
                         "data_timestamp": start - timedelta(seconds=5), "refresh_start_time": start,
                         "refresh_end_time": start + timedelta(seconds=2 + (len(name) % 3)), "state_message": None})
    return pd.DataFrame(rows)


def demo_task_history(now: datetime) -> pd.DataFrame:
    rows = []
    for i in range(8):
        t = now - timedelta(minutes=i)
        rows.append({"name": "T_HIGHLIGHTS", "state": "SUCCEEDED" if i % 4 != 3 else "SKIPPED",
                     "scheduled_time": t, "completed_time": t + timedelta(seconds=3), "error_message": None})
    for i in range(3):
        t = now - timedelta(minutes=5 * i)
        rows.append({"name": "T_SCOUTING", "state": "SUCCEEDED", "scheduled_time": t,
                     "completed_time": t + timedelta(seconds=11), "error_message": None})
    return pd.DataFrame(rows).sort_values("scheduled_time", ascending=False).reset_index(drop=True)


DEMO_WAREHOUSE = {"name": "MOTION_WH", "size": "X-Small", "auto_suspend": 300, "auto_resume": "true", "state": "SUSPENDED"}


def task_state_counts(df: Optional[pd.DataFrame]) -> pd.DataFrame:
    d = L.normalize_columns(df)
    if d.empty or not {"name", "state"}.issubset(d.columns):
        return pd.DataFrame(columns=["name"])
    return d.groupby(["name", "state"]).size().unstack(fill_value=0).reset_index()


# ---------------------------------------------------------------------------
# Everything DEMO mode needs, in one deterministic bundle
# ---------------------------------------------------------------------------
def build_lab_demo(ds: Optional[Mapping[str, Any]] = None, seed: int = 7) -> Dict[str, Any]:
    ds = ds or L.build_demo_dataset(seed=seed)
    now = pd.Timestamp(ds["events"]["event_ts"].max()).to_pydatetime().replace(microsecond=0) + timedelta(minutes=2)
    style = demo_player_style(ds["player_form"], ds["benchmarks"])
    summary = session_summary_from_events(ds["events"])
    return {
        "ds": ds,
        "now": now,
        "V_HIGHLIGHTS_FEED": demo_highlights(ds["events"], ds["players"]),
        "V_PLAYER_STYLE": style,
        "V_STYLE_TWINS": style_twins(style),
        "PLAYER_SCOUTING": demo_scouting(style, ds["player_form"], now),
        "SESSION_SUMMARY": summary,
        "PLAYER_PROGRESS": progress_from_summary(summary),
        "TIME_MACHINE_EVENTS": demo_retimed_events(ds["events"], now),
        "REFRESH_HISTORY": demo_refresh_history(now),
        "TASK_HISTORY": demo_task_history(now),
        "WAREHOUSE": dict(DEMO_WAREHOUSE),
    }
