"""Snowflake Lab: one page per Snowflake feature the game uses (judge-facing).

Object names follow sql/PLUS_CONTRACT.md. Every section is optional: if its object
or privilege is missing, it shows a short st.info naming the SQL file to run.
DEMO mode (no Snowflake, or MOTION_DEMO=1 / SNOWFLAKE_MOCK=1) uses deterministic
data from plus_logic.build_lab_demo(). Pure logic lives in plus_logic.py.

Every user-supplied value is a Snowpark bind parameter, except the Cortex Search
query, which SEARCH_PREVIEW needs as a constant: it is built as JSON in Python and
embedded as an escaped single-quoted literal (plus_logic.sql_string_literal).
"""
from __future__ import annotations

import inspect
import os
import re
import sys
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, Optional, Sequence

import altair as alt
import pandas as pd
import streamlit as st

try:  # logic.py / plus_logic.py live one folder up (next to app.py)
    _ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if _ROOT not in sys.path:
        sys.path.insert(0, _ROOT)
except NameError:  # pragma: no cover
    pass

import logic as L  # noqa: E402
import plus_logic as P  # noqa: E402

DB = L.safe_identifier(os.environ.get("SNOWFLAKE_DATABASE"), "MOTION_DB")
SCHEMA = L.safe_identifier(os.environ.get("SNOWFLAKE_SCHEMA"), "PUBLIC")

# Same palette as app.py (dataviz reference palette).
BLUE = "#2a78d6"
ORANGE = "#eb6834"
GRAY = "#b9b8b0"
MUTED = "#898781"
SEQ_BLUE = ["#cde2fb", "#86b6ef", "#3987e5", "#2a78d6", "#1c5cab", "#0d366b"]  # sequential, light -> dark

HINT_PIPELINES = "Run sql/pipelines.sql (as ACCOUNTADMIN) to create it."
HINT_CORTEX = "Run sql/cortex.sql (as ACCOUNTADMIN) to create it."
HINT_SETUP = "Run sql/setup.sql and sql/analytics.sql first."
HINT_ANALYST = ("Run sql/semantic.sql and upload sql/semantic_model/motion_boxing.yaml to "
                "@MOTION_DB.PUBLIC.SEMANTIC_MODELS (npm run streamlit:deploy does the upload).")


def T(name: str) -> str:
    return L.qualified(DB, SCHEMA, name)


# ---------------------------------------------------------------------------
# Streamlit version compatibility (SiS 1.22 .. 1.52), same approach as app.py
# ---------------------------------------------------------------------------
def _params_of(fn: Callable[..., Any]) -> Dict[str, inspect.Parameter]:
    try:
        return dict(inspect.signature(fn).parameters)
    except (TypeError, ValueError):
        return {}


def show_chart(chart: Any) -> None:
    if "width" in _params_of(st.altair_chart):
        st.altair_chart(chart, width="stretch")
    else:
        st.altair_chart(chart, use_container_width=True)


def show_table(df: pd.DataFrame) -> None:
    params = _params_of(st.dataframe)
    kwargs: Dict[str, Any] = {}
    if "hide_index" in params:
        kwargs["hide_index"] = True
    width = params.get("width")
    if width is None or width.default != "stretch":
        kwargs["use_container_width"] = True
    st.dataframe(df, **kwargs)


def _is_control_flow(exc: BaseException) -> bool:
    """Streamlit's rerun/stop exceptions must never be swallowed by a section guard."""
    return any(c.__name__ in ("RerunException", "StopException", "ScriptControlException")
               for c in type(exc).__mro__)


def explain(exc: BaseException, what: str, hint: str) -> None:
    kind = P.classify_error(exc)
    if kind == "missing":
        st.info("{} is not available yet. {} ({})".format(what, hint, P.short_error(exc, 140)))
    else:
        st.info("{} could not load: {}. {}".format(what, P.short_error(exc, 160), hint))


def attempt(what: str, hint: str, fn: Callable[[], Any]) -> Any:
    """Run one part of a section; on any error show st.info and return None."""
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        if _is_control_flow(exc):
            raise
        explain(exc, what, hint)
        return None


def section(title: str, feature: str, hint: str, body: Callable[[], None]) -> None:
    st.markdown("---")
    st.header(title)
    st.caption("Snowflake feature: " + feature)
    attempt(title, hint, body)


# ---------------------------------------------------------------------------
# Backend (same order as app.py: SiS session, local Snowpark, DEMO)
# ---------------------------------------------------------------------------
class Backend:
    def __init__(self, mode: str, session: Any = None, detail: str = "") -> None:
        self.mode, self.session, self.detail = mode, session, detail

    @property
    def is_demo(self) -> bool:
        return self.mode == "demo"


@st.cache_resource(show_spinner=False)
def get_backend() -> Backend:
    env = os.environ
    if L.demo_forced(env):
        return Backend("demo", detail="MOTION_DEMO / SNOWFLAKE_MOCK is set")
    try:
        import _snowflake  # noqa: F401 - only exists inside Streamlit in Snowflake
        from snowflake.snowpark.context import get_active_session

        # Without the _snowflake check, a local run would pick up the Snowpark session
        # another page created and wrongly report it as Streamlit in Snowflake.
        return Backend("snowflake", get_active_session(), "Streamlit in Snowflake session")
    except Exception:  # noqa: BLE001
        pass
    cfg = L.session_config_from_env(env)
    if cfg is None:
        return Backend("demo", detail="no Snowflake session and no SNOWFLAKE_* credentials in the environment")
    try:
        from snowflake.snowpark import Session

        return Backend("local", Session.builder.configs(cfg).create(), "local Snowpark session")
    except Exception as exc:  # noqa: BLE001
        return Backend("demo", detail="local Snowflake connection failed ({})".format(P.short_error(exc, 120)))


@st.cache_resource(show_spinner=False)
def lab_demo() -> Dict[str, Any]:
    return P.build_lab_demo()


def _run_sql(sql: str, params: Sequence[Any]) -> pd.DataFrame:
    session = get_backend().session
    return L.normalize_columns(session.sql(sql, params=list(params) if params else None).to_pandas())


@st.cache_data(ttl=10, show_spinner=False)
def q_live(sql: str, params: tuple = ()) -> pd.DataFrame:
    return _run_sql(sql, params)


@st.cache_data(ttl=30, show_spinner=False)
def q_player(sql: str, params: tuple = ()) -> pd.DataFrame:
    return _run_sql(sql, params)


@st.cache_data(ttl=600, show_spinner=False)
def q_static(sql: str, params: tuple = ()) -> pd.DataFrame:
    return _run_sql(sql, params)


def run_uncached(sql: str, params: Sequence[Any] = ()) -> pd.DataFrame:
    return _run_sql(sql, params)


def first(df: pd.DataFrame) -> Optional[Dict[str, Any]]:
    return L.first_row(df)


_MD_SPECIAL = re.compile(r"([\\`*_{}\[\]()#+!|<>~])")


def _md_escape(text: Any) -> str:
    return _MD_SPECIAL.sub(r"\\\1", str(text))


def fmt_num(value: Any, decimals: int = 0, suffix: str = "") -> str:
    out = L.fmt_num(value, decimals, suffix)
    return P.EMPTY if out == L.EMPTY else out


def first_or_empty(df: pd.DataFrame) -> Dict[str, Any]:
    return L.first_row(df) or {}


def scalar(df: pd.DataFrame) -> Any:
    return None if df is None or df.empty else df.iloc[0, 0]


def by_player(df: pd.DataFrame, pid: str) -> pd.DataFrame:
    return df[df["player_id"].astype(str) == str(pid)].reset_index(drop=True)


# ---------------------------------------------------------------------------
# Header + shared player picker
# ---------------------------------------------------------------------------
def players_frame(backend: Backend) -> pd.DataFrame:
    if backend.is_demo:
        return lab_demo()["ds"]["players"][["player_id", "name"]]
    return q_player(
        "SELECT player_id, COALESCE(MAX(name), 'Unknown') AS name, MAX(created_at) AS created_at "
        "FROM {} WHERE player_id IS NOT NULL GROUP BY player_id "
        "ORDER BY created_at DESC NULLS LAST LIMIT 500".format(T("PLAYERS")))


def pick_player(backend: Backend) -> Optional[Dict[str, str]]:
    players = attempt("Players (PLAYERS)", HINT_SETUP, lambda: players_frame(backend))
    if players is None or players.empty:
        if players is not None:
            st.info("No players yet. Box a round in the game first.")
        return None
    names = dict(zip(players["player_id"].astype(str), players["name"].fillna("Unknown").astype(str)))
    options = sorted(names, key=lambda p: (names[p].lower(), p))
    selected = st.session_state.get("selected_player_id")  # shared with the main page
    if selected not in names:
        selected = options[0]
    pid = st.selectbox("Player (used by the style, progress and heatmap sections)", options,
                       index=options.index(selected), format_func=lambda p: names.get(p, p))
    st.session_state["selected_player_id"] = pid
    return {"player_id": pid, "name": names.get(pid, "Unknown")}


# ---------------------------------------------------------------------------
# 1. Cortex Analyst
# ---------------------------------------------------------------------------
def _analyst_api() -> Optional[Any]:
    try:
        import _snowflake  # type: ignore  # only exists inside Streamlit in Snowflake

        return _snowflake if hasattr(_snowflake, "send_snow_api_request") else None
    except Exception:  # noqa: BLE001
        return None


def ask_analyst(backend: Backend, question: str) -> Dict[str, Any]:
    """One exchange: returns a display record {question, parsed, df, sql_error, canned}."""
    history = st.session_state.setdefault("lab_analyst_messages", [])
    api = None if backend.is_demo else _analyst_api()
    if api is None:
        resp, df = P.demo_analyst_answer(question, lab_demo()["ds"])
        return {"question": question, "parsed": P.parse_analyst_response(resp), "df": df, "sql_error": None,
                "canned": True}
    body = P.build_analyst_body(history, question)
    resp = api.send_snow_api_request("POST", P.ANALYST_ENDPOINT, {}, {}, body, None, P.ANALYST_TIMEOUT_MS)
    parsed = P.parse_analyst_response(resp)
    rec: Dict[str, Any] = {"question": question, "parsed": parsed, "df": None, "sql_error": None, "canned": False}
    if parsed["ok"]:
        history.append(P.user_message(question))
        history.append(parsed["message"])
        st.session_state["lab_analyst_messages"] = P.trim_history(history)
        if parsed["sql"]:
            if P.is_read_only_sql(parsed["sql"]):
                try:  # Analyst-generated SELECT, run as-is (it contains no user text binds)
                    rec["df"] = backend.session.sql(P.runnable_sql(parsed["sql"])).limit(1000).to_pandas()
                except Exception as exc:  # noqa: BLE001
                    rec["sql_error"] = P.short_error(exc)
            else:
                rec["sql_error"] = "Only single SELECT statements are run from this page."
    return rec


def auto_chart(df: pd.DataFrame) -> Optional[alt.Chart]:
    spec = P.auto_chart_spec(df)
    if spec is None:
        return None
    x, y, data = spec["x"], spec["y"], spec["data"]
    tooltip = [alt.Tooltip("{}:{}".format(x, "T" if spec["kind"] == "line" else "N")),
               alt.Tooltip("{}:Q".format(y), format=",.2f")]
    if spec["kind"] == "line":
        base = alt.Chart(data).encode(x=alt.X("{}:T".format(x), title=x), y=alt.Y("{}:Q".format(y), title=y),
                                      tooltip=tooltip)
        return (base.mark_line(color=BLUE, strokeWidth=2) + base.mark_point(color=BLUE, filled=True, size=48)
                ).properties(height=240)
    return alt.Chart(data).mark_bar(color=BLUE, size=16).encode(
        y=alt.Y("{}:N".format(x), sort="-x", title=None), x=alt.X("{}:Q".format(y), title=y), tooltip=tooltip,
    ).properties(height=max(120, 26 * len(data)))


def _queue_question(q: str) -> None:
    st.session_state["lab_pending_q"] = q


def render_analyst(backend: Backend) -> None:
    api_available = (not backend.is_demo) and _analyst_api() is not None
    if not api_available:
        why = "DEMO mode" if backend.is_demo else "outside Streamlit in Snowflake (no _snowflake module)"
        st.caption("{}: canned answers for the example questions below. In SiS this calls the Cortex Analyst REST "
                   "API with the semantic model {}.".format(why, P.SEMANTIC_MODEL_FILE))
    else:
        st.caption("Ask in plain English. Cortex Analyst turns it into SQL using the semantic model {} and the "
                   "page runs that SQL.".format(P.SEMANTIC_MODEL_FILE))
    with st.form("lab_analyst_form", clear_on_submit=True):
        q = st.text_input("Question", max_chars=L.MAX_QUESTION_CHARS, placeholder=P.DEMO_QUESTIONS[0])
        submitted = st.form_submit_button("Ask Cortex Analyst")
    cols = st.columns(len(P.DEMO_QUESTIONS))
    for i, (col, ex) in enumerate(zip(cols, P.DEMO_QUESTIONS)):
        col.button(ex, key="lab_ex_{}".format(i), on_click=_queue_question, args=(ex,))
    question = L.sanitize_question(q) if submitted else ""
    pending = st.session_state.pop("lab_pending_q", None)
    question = question or L.sanitize_question(pending or "")
    log = st.session_state.setdefault("lab_analyst_log", [])
    if question:
        with st.spinner("Cortex Analyst is writing SQL..."):
            log.append(ask_analyst(backend, question))
        del log[:-6]
    if not log:
        return
    if st.button("Clear conversation", key="lab_analyst_clear"):
        st.session_state["lab_analyst_log"] = []
        st.session_state["lab_analyst_messages"] = []
        return
    for n, rec in enumerate(reversed(log)):
        render_exchange(rec, latest=(n == 0), idx=len(log) - 1 - n)


def render_exchange(rec: Dict[str, Any], latest: bool, idx: int) -> None:
    parsed = rec["parsed"]
    st.markdown("**You:** {}".format(rec["question"]))
    if not parsed["ok"]:
        st.info("{} {}".format(parsed["error"], HINT_ANALYST if "semantic" in str(parsed["error"]).lower()
                               or "not found" in str(parsed["error"]).lower() else ""))
        return
    if parsed["text"]:
        st.markdown("**Analyst:** {}".format(parsed["text"]))
    if parsed["sql"]:
        vq = P.verified_query_used(parsed["confidence"])
        if vq:
            st.caption("Verified query: {} (answer matches a query the team verified in the semantic model)".format(vq))
        with st.expander("SQL", expanded=False):
            st.code(parsed["sql"], language="sql")
    for w in parsed.get("warnings") or []:
        st.caption("Analyst warning: {}".format(w))
    if rec.get("sql_error"):
        st.info("The generated SQL did not run: {}".format(rec["sql_error"]))
    df = rec.get("df")
    if isinstance(df, pd.DataFrame):
        df = L.normalize_columns(df)
        chart = auto_chart(df)
        if chart is not None:
            show_chart(chart)
        show_table(df)
        if rec.get("canned"):
            st.caption("Canned result computed from the DEMO dataset.")
    if latest and parsed["suggestions"]:
        st.caption("Suggested follow-ups")
        for j, s in enumerate(parsed["suggestions"][:3]):
            st.button(s, key="lab_sugg_{}_{}".format(idx, j), on_click=_queue_question, args=(s,))


# ---------------------------------------------------------------------------
# 2. Live highlights feed
# ---------------------------------------------------------------------------
def render_highlights(backend: Backend) -> None:
    st.caption("How it is produced: an append-only stream MOTION_EVENTS_HL_STREAM captures new punches; task "
               "T_HIGHLIGHTS runs every minute only when the stream has data (SYSTEM$STREAM_HAS_DATA), and writes "
               "room records, personal bests, punch milestones and anti-cheat flags (implausible speeds) to "
               "HIGHLIGHTS. V_HIGHLIGHTS_FEED shows the latest 50.")
    if backend.is_demo:
        raw = lab_demo()["V_HIGHLIGHTS_FEED"]
    else:
        raw = q_live("SELECT * FROM {} ORDER BY created_at DESC LIMIT 50".format(T("V_HIGHLIGHTS_FEED")))
    feed = P.shape_highlights(raw)
    if feed.empty:
        st.info("No highlights yet. The task writes them within a minute of new punches.")
        return
    for r in feed.head(8).to_dict("records"):
        when = pd.to_datetime(r["created_at"]).strftime("%H:%M") if r["created_at"] is not None else ""
        # plain markdown only: messages contain player names, which are user input
        st.markdown("{} **{}** {} ({})".format(r["icon"], r["kind_label"], _md_escape(r["message"] or ""), when))
    with st.expander("All {} highlights".format(len(feed))):
        view = feed.rename(columns={"icon": " ", "kind_label": "Kind", "created_at": "When", "name": "Player",
                                    "value": "Value", "unit": "Unit", "message": "Message"})
        show_table(view[[" ", "Kind", "When", "Player", "Value", "Unit", "Message"]])


# ---------------------------------------------------------------------------
# 3. Style twin and scouting
# ---------------------------------------------------------------------------
def style_chart(df: pd.DataFrame) -> alt.Chart:
    order = [P.STYLE_LABELS[k] for k in P.STYLE_COMPONENTS]
    base = alt.Chart(df).encode(y=alt.Y("label:N", sort=order, title=None))
    bars = base.mark_bar(color=BLUE, size=16).encode(
        x=alt.X("value:Q", title="Style component (0-100)", scale=alt.Scale(domain=[0, 100])),
        tooltip=[alt.Tooltip("label:N", title="Component"), alt.Tooltip("value:Q", title="Player", format=".0f"),
                 alt.Tooltip("pro:Q", title="Pro", format=".0f")])
    pro = base.mark_tick(color=MUTED, thickness=2, size=22).encode(x="pro:Q")
    labels = base.mark_text(align="left", dx=4, color=MUTED).encode(x="value:Q", text=alt.Text("value:Q", format=".0f"))
    return (bars + pro + labels).properties(height=230)


def render_style(backend: Backend, player: Optional[Dict[str, str]]) -> None:
    if player is None:
        st.info("Pick a player above.")
        return
    pid = player["player_id"]
    demo = lab_demo() if backend.is_demo else None

    def load_style() -> Optional[Dict[str, Any]]:
        if demo is not None:
            return first_or_empty(by_player(demo["V_PLAYER_STYLE"], pid))
        return first_or_empty(q_player("SELECT player_id, name, c_speed, c_reaction, c_accuracy, c_guard, c_symmetry, "
                              "c_endurance, pro_similarity_pct FROM {} WHERE player_id = ?".format(T("V_PLAYER_STYLE")),
                              (pid,)))

    def load_bench() -> pd.DataFrame:
        if demo is not None:
            return demo["ds"]["benchmarks"]
        return q_static("SELECT * FROM {} WHERE LOWER(sport) = 'boxing'".format(T("PRO_BENCHMARKS")))

    left, right = st.columns([3, 2])
    with left:
        row = attempt("Style vector (V_PLAYER_STYLE)", HINT_PIPELINES, load_style)
        if row:
            bench = attempt("Pro benchmarks (PRO_BENCHMARKS)", HINT_SETUP, load_bench)
            show_chart(style_chart(P.style_frame(row, P.pro_components(bench))))
            st.caption("Blue bar = {}; grey tick = pro average from PRO_BENCHMARKS. Each bar is one element of "
                       "the VECTOR(FLOAT, 6) style_vec.".format(player["name"]))
        elif row is not None:
            st.info("No style vector yet: V_PLAYER_STYLE lists players with at least one punch in PLAYER_FORM.")
    with right:
        if row:
            st.metric("Similarity to a pro", fmt_num(row.get("pro_similarity_pct"), 1, " %"))

        def load_twin() -> Optional[Dict[str, Any]]:
            if demo is not None:
                return first_or_empty(by_player(demo["V_STYLE_TWINS"], pid))
            return first_or_empty(q_player("SELECT twin_player_id, twin_name, similarity_pct FROM {} WHERE player_id = ?"
                                  .format(T("V_STYLE_TWINS")), (pid,)))

        twin = attempt("Style twin (V_STYLE_TWINS)", HINT_PIPELINES, load_twin)
        if twin:
            st.metric("Style twin", str(twin.get("twin_name") or "Unknown"),
                      fmt_num(twin.get("similarity_pct"), 1, " % similar"), delta_color="off")
        elif twin is not None:
            st.caption("No style twin yet: needs at least two players with punches.")

        def load_scouting() -> Optional[Dict[str, Any]]:
            if demo is not None:
                return first_or_empty(by_player(demo["PLAYER_SCOUTING"], pid))
            return first_or_empty(q_player("SELECT fighting_style, scouting_report, updated_at FROM {} WHERE player_id = ?"
                                  .format(T("PLAYER_SCOUTING")), (pid,)))

        scout = attempt("Scouting report (PLAYER_SCOUTING)", HINT_CORTEX, load_scouting)
        if scout:
            st.metric("Fighting style (AI_CLASSIFY)", str(scout.get("fighting_style") or P.EMPTY))
            st.markdown(str(scout.get("scouting_report") or ""))
            st.caption("Written by task T_SCOUTING with AI_CLASSIFY + AI_COMPLETE. Every 5 minutes, if the append-only "
                       "stream PLAYER_FORM_STREAM on MOTION_EVENTS has new events, the task refreshes PLAYER_FORM and "
                       "re-scouts players (10+ punches) whose punch count changed.")
        elif scout is not None:
            st.caption("No scouting report yet: T_SCOUTING scans players with at least 10 punches every 5 minutes.")


# ---------------------------------------------------------------------------
# 4. Progress across sessions
# ---------------------------------------------------------------------------
def progress_chart(df: pd.DataFrame, field: str, title: str, color: str) -> alt.Chart:
    base = alt.Chart(df).encode(
        x=alt.X("session_index:O", title="Round number", axis=alt.Axis(labelAngle=0)),
        y=alt.Y("{}:Q".format(field), title=title, scale=alt.Scale(zero=False)),
        tooltip=[alt.Tooltip("session_index:O", title="Round"), alt.Tooltip("{}:Q".format(field), title=title,
                                                                             format=",.2f")])
    return (base.mark_line(color=color, strokeWidth=2) + base.mark_point(color=color, filled=True, size=64)
            ).properties(height=220)


def render_progress(backend: Backend, player: Optional[Dict[str, str]]) -> None:
    if player is None:
        st.info("Pick a player above.")
        return
    pid = player["player_id"]
    if backend.is_demo:
        hist = by_player(lab_demo()["SESSION_SUMMARY"], pid)
    else:
        hist = q_player("SELECT session_index, session_id, score, avg_speed, accuracy_pct FROM {} "
                        "WHERE player_id = ? ORDER BY session_index".format(T("SESSION_SUMMARY")), (pid,))
    if hist.empty:
        st.info("No rounds for this player in SESSION_SUMMARY yet (the chain refreshes about once a minute).")
        return
    c1, c2 = st.columns(2)
    with c1:
        st.markdown("**Score per round**")
        show_chart(progress_chart(hist, "score", "Score", BLUE))
    with c2:
        st.markdown("**Avg punch speed per round**")
        show_chart(progress_chart(hist, "avg_speed", "Avg speed (m/s)", BLUE))

    def load_prog() -> Optional[Dict[str, Any]]:
        if backend.is_demo:
            return first_or_empty(by_player(lab_demo()["PLAYER_PROGRESS"], pid))
        return first_or_empty(q_player("SELECT * FROM {} WHERE player_id = ?".format(T("PLAYER_PROGRESS")), (pid,)))

    prog = attempt("Trends (PLAYER_PROGRESS)", HINT_PIPELINES, load_prog)
    if not prog:
        return
    improving = prog.get("improving")
    sessions = P._f(prog.get("sessions")) or 0
    verdict = ("Needs 2+ rounds" if sessions < 2 else
               "Improving" if improving is True else "Not improving yet")
    m = st.columns(5)
    m[0].metric("Verdict", verdict)
    for col, (label, key, unit, hib, dec) in zip(m[1:], [
            ("Score trend", "score_trend_per_session", "pts", True, 1),
            ("Speed trend", "speed_trend_mps_per_session", "m/s", True, 2),
            ("Accuracy trend", "accuracy_trend_pct_per_session", "pts", True, 1),
            ("Reaction trend", "reaction_trend_ms_per_session", "ms", False, 1)]):
        txt, word = P.trend_text(prog.get(key), unit, hib, dec)
        col.metric(label, txt, word, delta_color="off")
    st.caption("Trends are REGR_SLOPE over round number in PLAYER_PROGRESS. {} rounds, best score {}, last score {}."
               .format(fmt_num(prog.get("sessions")), fmt_num(prog.get("best_score")),
                       fmt_num(prog.get("last_score"))))


# ---------------------------------------------------------------------------
# 5. Punch heatmap
# ---------------------------------------------------------------------------
HEATMAP_SQL = """
WITH ev AS (
  SELECT session_id, LOWER(event_type) AS punch_type, speed_mps,
         DATEDIFF('millisecond', MIN(event_ts) OVER (PARTITION BY session_id), event_ts) AS offset_ms
  FROM {events}
  WHERE player_id IS NOT NULL {where}
)
SELECT punch_type, FLOOR(offset_ms / 10000) AS bucket, COUNT(*) AS punches, AVG(speed_mps) AS avg_speed
FROM ev
WHERE punch_type IN ('jab', 'cross', 'hook', 'uppercut')
GROUP BY 1, 2
"""


def heatmap_chart(grid: pd.DataFrame, metric: str) -> alt.Chart:
    title = "Punches" if metric == "punches" else "Avg speed (m/s)"
    order = list(grid.drop_duplicates("bucket").sort_values("bucket")["bucket_label"])
    return alt.Chart(grid).mark_rect(stroke="white", strokeWidth=2).encode(
        x=alt.X("bucket_label:O", sort=order, title="Seconds into the round", axis=alt.Axis(labelAngle=-45)),
        y=alt.Y("punch_type:N", sort=P.PUNCH_TYPES, title=None),
        color=alt.Color("{}:Q".format(metric), title=title, scale=alt.Scale(range=SEQ_BLUE)),
        tooltip=[alt.Tooltip("punch_type:N", title="Punch"), alt.Tooltip("bucket_label:O", title="Window"),
                 alt.Tooltip("punches:Q", title="Punches"),
                 alt.Tooltip("avg_speed:Q", title="Avg speed (m/s)", format=".2f")],
    ).properties(height=200)


def render_heatmap(backend: Backend, player: Optional[Dict[str, str]]) -> None:
    c1, c2 = st.columns(2)
    scope_opts = ["Latest round of the picked player", "All players, all rounds"]
    scope = c1.radio("Scope", scope_opts, index=0 if player else 1, key="lab_heat_scope")
    metric = c2.radio("Colour", ["Punch count", "Avg speed"], key="lab_heat_metric")
    metric_col = "punches" if metric == "Punch count" else "avg_speed"
    mine = scope == scope_opts[0]
    if mine and player is None:
        st.info("Pick a player above, or choose all players.")
        return
    if backend.is_demo:
        ev = lab_demo()["ds"]["events"]
        if mine:
            ev = by_player(ev, player["player_id"])
            latest = ev.groupby("session_id")["event_ts"].max().sort_values().index[-1] if not ev.empty else None
            ev = ev[ev["session_id"] == latest]
        agg = P.heatmap_agg_from_events(ev)
    elif mine:
        where = ("AND player_id = ? AND session_id = (SELECT session_id FROM {} WHERE player_id = ? "
                 "GROUP BY session_id ORDER BY MAX(event_ts) DESC LIMIT 1)".format(T("MOTION_EVENTS")))
        agg = q_player(HEATMAP_SQL.format(events=T("MOTION_EVENTS"), where=where),
                       (player["player_id"], player["player_id"]))
    else:
        agg = q_player(HEATMAP_SQL.format(events=T("MOTION_EVENTS"), where=""))
    grid = P.shape_heatmap(agg)
    if grid.empty:
        st.info("No punches recorded for this selection yet.")
        return
    show_chart(heatmap_chart(grid, metric_col))
    st.caption("10-second windows from the round's first event; events after {} s fold into the last column. "
               "Darker = more.".format(P.HEATMAP_BUCKET_S * P.HEATMAP_MAX_BUCKETS))


# ---------------------------------------------------------------------------
# 6. Time machine
# ---------------------------------------------------------------------------
TIME_MACHINE_SQL = """
SELECT e.player_id, e.session_id, SUM(COALESCE(e.points, 0)) AS score,
       MAX(CASE WHEN LOWER(e.event_type) IN ('jab', 'cross', 'hook', 'uppercut') THEN e.speed_mps END) AS fastest_punch,
       MIN(CASE WHEN e.reaction_ms > 0 THEN e.reaction_ms END) AS best_reaction_ms
FROM {events} {at} e
WHERE e.player_id IS NOT NULL AND LOWER(COALESCE(e.sport, 'boxing')) = 'boxing'
GROUP BY e.player_id, e.session_id
"""


def time_machine_scores(backend: Backend, minutes: int) -> pd.DataFrame:
    if backend.is_demo:
        d = lab_demo()
        ev = P.events_as_of(d["TIME_MACHINE_EVENTS"], d["now"] - timedelta(minutes=minutes))
        return P.session_scores_from_events(ev)
    offset = P.time_travel_offset_s(minutes)
    if offset == 0:
        return q_live(TIME_MACHINE_SQL.format(events=T("MOTION_EVENTS"), at=""))
    try:  # bind the offset when the account accepts it in AT(...)
        return q_live(TIME_MACHINE_SQL.format(events=T("MOTION_EVENTS"), at="AT(OFFSET => ?)"), (offset,))
    except Exception as exc:  # noqa: BLE001
        if P.classify_error(exc) != "other":
            raise
        # Fallback: a validated integer (0..3600 s), never text.
        return q_live(TIME_MACHINE_SQL.format(events=T("MOTION_EVENTS"), at="AT(OFFSET => {:d})".format(int(offset))))


def lb_view(lb: pd.DataFrame, with_move: bool) -> pd.DataFrame:
    cols = {"rank": "#", "name": "Player", "best_score": "Best score", "movement": "Since then"}
    keep = ["#", "Player", "Best score"] + (["Since then"] if with_move else [])
    return lb.rename(columns=cols)[keep]


def render_time_machine(backend: Backend) -> None:
    minutes = st.slider("Minutes ago", 0, P.MAX_TIME_TRAVEL_MIN, 15, step=5, key="lab_tt_minutes")
    players = attempt("Players (PLAYERS)", HINT_SETUP, lambda: players_frame(backend))
    now_lb = P.rank_time_machine(time_machine_scores(backend, 0), players)
    try:
        then_lb = P.rank_time_machine(time_machine_scores(backend, minutes), players)
    except Exception as exc:  # noqa: BLE001
        if _is_control_flow(exc):
            raise
        if P.classify_error(exc) == "time_travel":
            st.info("Time Travel has no data for MOTION_EVENTS {} minutes ago: the table did not exist yet, was "
                    "recreated, or DATA_RETENTION_TIME_IN_DAYS is 0. Pick a smaller value.".format(minutes))
            return
        raise
    left, right = st.columns(2)
    with left:
        st.markdown("**{} minutes ago**".format(minutes) if minutes else "**Now (slider at 0)**")
        if then_lb.empty:
            st.info("Nobody had boxed yet at that point.")
        else:
            show_table(lb_view(then_lb, False))
    with right:
        st.markdown("**Now**")
        if now_lb.empty:
            st.info("No rounds yet.")
        else:
            show_table(lb_view(P.compare_leaderboards(now_lb, then_lb), True))
    if backend.is_demo:
        st.caption("DEMO: the latest rounds are placed in the last hour so the slider has something to show.")
    else:
        st.caption("Left table: SELECT ... FROM MOTION_EVENTS AT(OFFSET => -{} * 60), same score rule as "
                   "V_LEADERBOARD (best SUM(points) per round).".format(minutes))


# ---------------------------------------------------------------------------
# 7. Crowd coach (AI_AGG)
# ---------------------------------------------------------------------------
_SUMMARIES = ("SELECT ai_coach_json:summary::STRING AS summary FROM {} WHERE ai_coach_json:summary IS NOT NULL "
              "ORDER BY COALESCE(ended_at, started_at) DESC NULLS LAST LIMIT 50")


def crowd_coach(backend: Backend) -> Dict[str, str]:
    if backend.is_demo:
        return {"answer": P.demo_crowd_coach(lab_demo()["V_PLAYER_STYLE"]), "source": "DEMO (rule-based stand-in)"}
    sub = _SUMMARIES.format(T("SESSIONS"))
    try:
        sql = "SELECT AI_AGG(summary, {}) AS answer FROM ({})".format(P.sql_string_literal(P.CROWD_INSTRUCTION), sub)
        answer = scalar(run_uncached(sql))
        if answer:
            return {"answer": str(answer), "source": "AI_AGG"}
    except Exception as exc:  # noqa: BLE001
        if _is_control_flow(exc):
            raise
    sql = ("SELECT AI_COMPLETE({}, ? || LISTAGG(summary, ' | ')) AS answer FROM ({}) "
           "HAVING COUNT(summary) > 0"
           .format(P.sql_string_literal(P.CROWD_MODEL), sub))
    answer = scalar(run_uncached(sql, (P.CROWD_INSTRUCTION + "\n\nSummaries: ",)))
    return {"answer": L.parse_cortex_answer(answer) or "No coach summaries in SESSIONS yet.",
            "source": "AI_COMPLETE ({}) fallback".format(P.CROWD_MODEL)}


def render_crowd(backend: Backend) -> None:
    st.caption("One AI_AGG call reads the coach summaries of the last 50 rounds (SESSIONS.ai_coach_json:summary) "
               "and writes advice for the whole room. Runs only when you click: it spends Cortex credits.")
    if st.button("Coach the room", key="lab_crowd_btn"):
        with st.spinner("Aggregating the last 50 rounds..."):
            st.session_state["lab_crowd"] = crowd_coach(backend)
    res = st.session_state.get("lab_crowd")
    if res:
        st.markdown(res["answer"])
        st.caption("Source: {}".format(res["source"]))


# ---------------------------------------------------------------------------
# 8. Under the hood
# ---------------------------------------------------------------------------
REFRESH_SQL = ("SELECT name, state, refresh_action, refresh_trigger, data_timestamp, refresh_start_time, "
               "refresh_end_time, state_message "
               "FROM TABLE({}.INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY()) "
               "WHERE name IN ('PLAYER_FORM', 'SESSION_SUMMARY', 'PLAYER_PROGRESS') "
               "ORDER BY refresh_start_time DESC NULLS LAST LIMIT 30")
TASK_SQL = ("SELECT name, state, scheduled_time, completed_time, error_message "
            "FROM TABLE({}.INFORMATION_SCHEMA.TASK_HISTORY("
            "SCHEDULED_TIME_RANGE_START => DATEADD('hour', -12, CURRENT_TIMESTAMP()), RESULT_LIMIT => 200)) "
            "WHERE name IN ('T_HIGHLIGHTS', 'T_SCOUTING') ORDER BY scheduled_time DESC LIMIT 30")


def render_under_the_hood(backend: Backend) -> None:
    demo = lab_demo() if backend.is_demo else None
    c1, c2 = st.columns(2)
    with c1:
        st.markdown("**Dynamic Table refreshes** (PLAYER_FORM, SESSION_SUMMARY, PLAYER_PROGRESS)")
        df = attempt("Dynamic table refresh history", HINT_PIPELINES,
                     lambda: demo["REFRESH_HISTORY"] if demo else q_live(REFRESH_SQL.format(DB)))
        if df is not None:
            if df.empty:
                st.info("No refreshes recorded yet.")
            else:
                show_table(df)
    with c2:
        st.markdown("**Task runs** (T_HIGHLIGHTS, T_SCOUTING)")
        df = attempt("Task history (needs MONITOR or OWNERSHIP on the tasks)", HINT_PIPELINES + " " + HINT_CORTEX,
                     lambda: demo["TASK_HISTORY"] if demo else q_live(TASK_SQL.format(DB)))
        if df is not None:
            if df.empty:
                st.info("No task runs in the last 12 hours. Check that the tasks are resumed.")
            else:
                show_table(P.task_state_counts(df))
                with st.expander("Last 30 runs"):
                    show_table(df)

    st.markdown("**Cortex Search over COACH_DRILLS**")
    st.caption("SNOWFLAKE.CORTEX.SEARCH_PREVIEW on the COACH_DRILL_SEARCH service (hybrid vector + keyword search, "
               "filtered by the focus attribute). The game's coach card is grounded on the same service.")
    with st.form("lab_search_form"):
        q = st.text_input("Search drills", value="keep my hands up when I get tired", max_chars=P.MAX_SEARCH_CHARS)
        focus = st.selectbox("Focus filter", ["(any)"] + P.DRILL_FOCUS)
        go = st.form_submit_button("Search")
    if go:
        f = None if focus == "(any)" else focus

        def search() -> pd.DataFrame:
            if demo:
                return P.demo_drill_search(q, f)
            return P.parse_search_results(scalar(run_uncached(P.search_preview_sql(q, f))))

        res = attempt("Cortex Search (COACH_DRILL_SEARCH)", HINT_CORTEX, search)
        if res is not None:
            if res.empty:
                st.info("No matching drills.")
            else:
                show_table(res)

    st.markdown("**Warehouse and cost**")

    def wh() -> Optional[Dict[str, Any]]:
        if demo:
            return demo["WAREHOUSE"]
        return first_or_empty(q_static("SHOW WAREHOUSES LIKE 'MOTION_WH'"))

    info = attempt("Warehouse MOTION_WH", HINT_SETUP, wh)
    if info:
        m = st.columns(3)
        m[0].metric("MOTION_WH size", str(info.get("size") or P.EMPTY))
        m[1].metric("Auto-suspend", fmt_num(info.get("auto_suspend"), 0, " s"))
        m[2].metric("State", str(info.get("state") or P.EMPTY))
    elif info is not None:
        st.info("SHOW WAREHOUSES returned nothing for MOTION_WH: the app owner role needs USAGE or MONITOR on it.")
    st.caption("Cost note: an X-Small warehouse bills 1 credit per hour only while running and suspends after "
               "300 s idle. The dynamic tables and tasks use MOTION_WH (tasks skip when their stream is empty). "
               "Cortex functions, Cortex Analyst and Cortex Search bill separately by tokens, messages and "
               "indexed data; the crowd coach runs only on click.")


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------
def main() -> None:
    try:
        st.set_page_config(layout="wide")
    except Exception:  # noqa: BLE001
        pass
    backend = get_backend()
    st.title("Snowflake Lab")
    st.caption("Every section below is one Snowflake feature working on live game data. Objects: {}.{}"
               .format(DB, SCHEMA))
    if backend.is_demo:
        st.info("DEMO mode: synthetic data, no Snowflake connection ({}).".format(backend.detail))
    with st.sidebar:
        st.caption("Lab data source: {} ({})".format(backend.mode, backend.detail))
        if st.button("Clear Lab cache", key="lab_clear_cache"):
            st.cache_data.clear()

    player = pick_player(backend)

    section("1. Ask your stats", "Cortex Analyst (semantic model YAML on a stage, REST API from SiS)", HINT_ANALYST,
            lambda: render_analyst(backend))
    section("2. Live highlights feed", "Streams + Tasks (stream on MOTION_EVENTS, task every minute)",
            HINT_PIPELINES, lambda: render_highlights(backend))
    section("3. Style twin and scouting", "VECTOR(FLOAT, 6) + VECTOR_COSINE_SIMILARITY, AI_CLASSIFY + AI_COMPLETE",
            HINT_PIPELINES, lambda: render_style(backend, player))
    section("4. Progress across sessions", "Dynamic Table chain (MOTION_EVENTS -> SESSION_SUMMARY -> PLAYER_PROGRESS)",
            HINT_PIPELINES, lambda: render_progress(backend, player))
    section("5. Punch heatmap", "SQL window functions over raw MOTION_EVENTS", HINT_SETUP,
            lambda: render_heatmap(backend, player))
    section("6. Time machine", "Time Travel (AT(OFFSET => ...) on MOTION_EVENTS)", HINT_SETUP,
            lambda: render_time_machine(backend))
    section("7. Crowd coach", "AI_AGG (aggregate LLM over many rows), COMPLETE fallback",
            "Needs SESSIONS rows with ai_coach_json and the SNOWFLAKE.CORTEX_USER database role.",
            lambda: render_crowd(backend))
    section("8. Under the hood", "Dynamic Table refresh history, TASK_HISTORY, Cortex Search, warehouse settings",
            HINT_PIPELINES, lambda: render_under_the_hood(backend))


main()
