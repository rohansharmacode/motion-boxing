"""Tests for plus_logic.py and an AppTest smoke test of pages/1_Snowflake_Lab.py."""
import json
import os
import re
import sys
import types
from datetime import date, datetime, timedelta

import pandas as pd
import pytest
import streamlit as st
from streamlit.testing.v1 import AppTest

import logic as L
import plus_logic as P

PAGE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "pages", "1_Snowflake_Lab.py"))
TIMEOUT = 60


@pytest.fixture(scope="module")
def lab():
    return P.build_lab_demo()


# ---------------------------------------------------------------- SQL literal / Cortex Search
def test_sql_string_literal_escapes_backslash_then_quote():
    assert P.sql_string_literal("plain") == "'plain'"
    assert P.sql_string_literal("it's") == "'it''s'"
    assert P.sql_string_literal("a\\b") == "'a\\\\b'"
    assert P.sql_string_literal("\\'") == "'\\\\'''"  # backslash doubled first, then the quote
    assert P.sql_string_literal("x\x00y\x07") == "'xy'"
    assert P.sql_string_literal(None) == "''"


def test_search_json_and_sql_are_safe():
    evil = "'); DROP TABLE MOTION_EVENTS; -- \\ café"
    js = P.build_search_json(evil, "guard", 3)
    body = json.loads(js)
    assert body["query"] == L.sanitize_question(evil, P.MAX_SEARCH_CHARS)
    assert body["filter"] == {"@eq": {"focus": "guard"}} and body["columns"] == P.SEARCH_COLUMNS
    assert js.isascii()
    sql = P.search_preview_sql(evil, "guard")
    m = re.fullmatch(r"SELECT SNOWFLAKE\.CORTEX\.SEARCH_PREVIEW\('MOTION_DB\.PUBLIC\.COACH_DRILL_SEARCH', '(.*)'\) AS result", sql)
    assert m, sql
    inner = m.group(1)
    # every quote inside the literal is doubled, so the literal cannot be closed early
    assert re.search(r"(?<!')'(?!')", inner) is None
    # undo Snowflake escaping -> the original JSON
    assert json.loads(inner.replace("''", "'").replace("\\\\", "\\")) == body


def test_search_json_ignores_unknown_focus_and_caps_length():
    body = json.loads(P.build_search_json("x" * 500, "hacking", 99))
    assert "filter" not in body and len(body["query"]) <= P.MAX_SEARCH_CHARS and body["limit"] == 10


def test_parse_search_results_string_or_object():
    payload = {"results": [{"DRILL_ID": "D1", "title": "Jab", "focus": "speed", "level": "beginner",
                            "description": "d", "cues": "c"}], "request_id": "r"}
    for raw in (json.dumps(payload), payload):
        df = P.parse_search_results(raw)
        assert list(df.columns) == P.SEARCH_COLUMNS and df.iloc[0]["drill_id"] == "D1"
    assert P.parse_search_results("not json").empty
    assert P.parse_search_results(None).empty


def test_classify_error():
    assert P.classify_error("Time travel data is not available for table MOTION_EVENTS") == "time_travel"
    assert P.classify_error("SQL compilation error: Object 'X' does not exist or not authorized.") == "missing"
    assert P.classify_error("Unknown function AI_AGG") == "missing"
    assert P.classify_error("Warehouse suspended") == "other"


# ---------------------------------------------------------------- Cortex Analyst
def _resp(content, status=200):
    return {"status": status, "content": json.dumps(content)}


def test_parse_analyst_response_ok():
    msg = {"role": "analyst", "content": [
        {"type": "text", "text": "This is the top player."},
        {"type": "sql", "statement": "SELECT 1", "confidence": {"verified_query_used": {"name": "top"}}},
        {"type": "suggestions", "suggestions": ["A?", "B?"]}, {"type": "future_type", "x": 1}]}
    out = P.parse_analyst_response(_resp({"message": msg, "request_id": "abc"}))
    assert out["ok"] and out["text"] == "This is the top player." and out["sql"] == "SELECT 1"
    assert out["suggestions"] == ["A?", "B?"] and out["request_id"] == "abc"
    assert out["message"] == msg and out["warnings"] == []
    with_warn = P.parse_analyst_response(_resp({"message": msg, "warnings": [{"message": "w1"}, "bad"]}))
    assert with_warn["warnings"] == ["w1"]
    assert P.verified_query_used(out["confidence"]) == "top"


def test_parse_analyst_response_errors():
    out = P.parse_analyst_response(_resp({"message": "Semantic model file not found", "error_code": "392700"}, 400))
    assert not out["ok"] and "400" in out["error"] and "not found" in out["error"] and "392700" in out["error"]
    assert not P.parse_analyst_response(None)["ok"]
    assert not P.parse_analyst_response({"status": 500, "content": "boom"})["ok"]
    assert not P.parse_analyst_response(_resp({"request_id": "x"}))["ok"]  # 200 without message


def test_history_alternates_and_trims():
    u = lambda i: P.user_message("q{}".format(i))  # noqa: E731
    a = lambda i: {"role": "analyst", "content": [{"type": "text", "text": "a{}".format(i)}]}  # noqa: E731
    hist = [u(0), u(1), a(1)] + [m for i in range(2, 8) for m in (u(i), a(i))] + [u(99)]
    trimmed = P.trim_history(hist, max_turns=3)
    assert [m["role"] for m in trimmed] == ["user", "analyst"] * 3
    assert trimmed[0]["content"][0]["text"] == "q5"
    body = P.build_analyst_body(hist, "new?")
    assert body["semantic_model_file"] == P.SEMANTIC_MODEL_FILE and body["stream"] is False
    roles = [m["role"] for m in body["messages"]]
    assert roles[-1] == "user" and body["messages"][-1]["content"][0]["text"] == "new?"
    assert all(r1 != r2 for r1, r2 in zip(roles, roles[1:]))


@pytest.mark.parametrize("sql,ok", [
    ("SELECT 1", True), ("with x as (select 1) select * from x;", True), ("-- c\nSELECT 1", True),
    ("DELETE FROM PLAYERS", False), ("SELECT 1; DROP TABLE X", False), ("", False), (None, False),
])
def test_is_read_only_sql(sql, ok):
    assert P.is_read_only_sql(sql) is ok


def test_auto_chart_spec():
    cat = pd.DataFrame({"NAME": ["a", "b"], "AVG_SPEED": [7.1, 6.2]})
    spec = P.auto_chart_spec(cat)
    assert spec["x"] == "NAME" and spec["y"] == "AVG_SPEED" and spec["kind"] == "bar"
    days = pd.DataFrame({"day": [date(2026, 11, 20), date(2026, 11, 21)], "punches": [3, 4]})
    assert P.auto_chart_spec(days)["kind"] == "line"
    from decimal import Decimal
    dec = pd.DataFrame({"t": ["jab", "hook"], "n": [Decimal("3"), Decimal("4")]})
    assert P.auto_chart_spec(dec)["y"] == "n"
    assert P.auto_chart_spec(pd.DataFrame({"a": [1], "b": [2]})) is None  # no category
    assert P.auto_chart_spec(pd.DataFrame({"a": ["x"]})) is None
    assert P.auto_chart_spec(None) is None


def test_demo_analyst_answers_three_questions(lab):
    for q in P.DEMO_QUESTIONS:
        resp, df = P.demo_analyst_answer(q, lab["ds"])
        parsed = P.parse_analyst_response(resp)
        assert parsed["ok"] and parsed["sql"] and P.is_read_only_sql(parsed["sql"])
        assert df is not None and not df.empty and P.auto_chart_spec(df) is not None
        assert P.verified_query_used(parsed["confidence"])
    resp, df = P.demo_analyst_answer("What is the meaning of life?", lab["ds"])
    parsed = P.parse_analyst_response(resp)
    assert parsed["ok"] and parsed["sql"] is None and df is None and parsed["suggestions"] == P.DEMO_QUESTIONS


# ---------------------------------------------------------------- style vectors
def test_style_components_formulas_and_nulls():
    c = P.style_components({"avg_speed": 7.5, "avg_reaction_ms": 260, "accuracy_pct": 120, "guard_pct": None,
                            "symmetry_pct": 80, "fatigue_drop_pct": 10})
    assert c == {"speed": 75.0, "reaction": 75.0, "accuracy": 100.0, "guard": 50.0, "symmetry": 80.0, "endurance": 80.0}
    assert P.style_vector(c) == pytest.approx([0.25, 0.25, 0.5, 0.0, 0.3, 0.3])
    assert P.similarity_pct(P.cosine_similarity([1, 0], [1, 0])) == 100.0
    assert P.similarity_pct(P.cosine_similarity([1, 0], [-1, 0])) == 0.0
    assert P.cosine_similarity([0, 0], [1, 0]) is None


def test_pro_components_from_benchmarks():
    pro = P.pro_components(pd.DataFrame(L.DEMO_BENCHMARKS, columns=["sport", "metric", "p25", "p50", "p75", "p90",
                                                                    "pro_avg", "higher_is_better"]))
    assert pro["speed"] == 95.0 and pro["reaction"] == pytest.approx(96.9, abs=0.1) and pro["endurance"] == 92.0
    assert P.pro_components(None) == pro  # falls back to the seeded values


def test_style_twins_are_other_players_and_symmetric_best(lab):
    style, twins = lab["V_PLAYER_STYLE"], lab["V_STYLE_TWINS"]
    assert len(twins) == len(style)
    assert (twins["player_id"] != twins["twin_player_id"]).all()
    assert twins["similarity_pct"].between(0, 100).all()
    assert style["pro_similarity_pct"].between(0, 100).all()
    assert set(lab["PLAYER_SCOUTING"]["fighting_style"]) <= set(P.FIGHTING_STYLES)
    assert "\u2014" not in " ".join(lab["PLAYER_SCOUTING"]["scouting_report"])


# ---------------------------------------------------------------- progress
def test_regr_slope():
    assert P.regr_slope([1, 2, 3], [2, 4, 6]) == pytest.approx(2.0)
    assert P.regr_slope([1, 2, None], [1, 3, 9]) == pytest.approx(2.0)
    assert P.regr_slope([1], [1]) is None
    assert P.regr_slope([2, 2], [1, 5]) is None


def test_session_summary_and_progress(lab):
    s, p = lab["SESSION_SUMMARY"], lab["PLAYER_PROGRESS"]
    assert list(s.columns) == P.SUMMARY_COLUMNS
    assert len(s) == len(lab["ds"]["sessions"])
    for _, g in s.groupby("player_id"):
        assert list(g.sort_values("session_start_ts")["session_index"]) == list(range(1, len(g) + 1))
    # score matches the SESSIONS demo summary (SUM(points) of all events)
    merged = s.merge(lab["ds"]["sessions"][["session_id", "score"]], on="session_id", suffixes=("", "_s"))
    assert (merged["score"] == merged["score_s"]).all()
    assert list(p.columns) == P.PROGRESS_COLUMNS and len(p) == len(L.DEMO_PLAYERS)
    row = p.iloc[0]
    assert row["improving"] == (row["score_trend_per_session"] > 0)


def test_trend_text():
    assert P.trend_text(0.25, "m/s", True, 2) == ("+0.25 m/s/round", "improving")
    assert P.trend_text(-3, "ms", False) == ("-3.0 ms/round", "improving")
    assert P.trend_text(-3, "pts", True)[1] == "slipping"
    assert P.trend_text(None, "pts")[1] == "needs 2+ rounds"


# ---------------------------------------------------------------- heatmap
def test_shape_heatmap_fills_grid_and_folds_late_buckets():
    agg = pd.DataFrame({"PUNCH_TYPE": ["JAB", "jab", "hook", "block", "cross"],
                        "BUCKET": [0, 0, 2, 1, 40], "PUNCHES": [2, 2, 3, 9, 1], "AVG_SPEED": [6.0, 8.0, 5.0, 0, 9.0]})
    g = P.shape_heatmap(agg, max_buckets=5)
    assert len(g) == 4 * 5 and set(g["punch_type"]) == set(P.PUNCH_TYPES)
    jab0 = g[(g.punch_type == "jab") & (g.bucket == 0)].iloc[0]
    assert jab0["punches"] == 4 and jab0["avg_speed"] == 7.0 and jab0["bucket_label"] == "0-10 s"
    assert g[(g.punch_type == "cross") & (g.bucket == 4)].iloc[0]["punches"] == 1  # folded
    assert g[(g.punch_type == "uppercut")]["punches"].sum() == 0
    assert P.shape_heatmap(None).empty


def test_heatmap_from_demo_events_counts_all_punches(lab):
    ev = lab["ds"]["events"]
    agg = P.heatmap_agg_from_events(ev)
    assert int(agg["punches"].sum()) == int(ev["event_type"].isin(P.PUNCH_TYPES).sum())
    assert agg["bucket"].min() == 0


# ---------------------------------------------------------------- time machine
def test_rank_time_machine_matches_demo_leaderboard(lab):
    ds = lab["ds"]
    lb = P.rank_time_machine(P.session_scores_from_events(ds["events"]), ds["players"])
    exp = ds["leaderboard"]
    assert list(lb["player_id"]) == list(exp["player_id"])
    assert list(lb["best_score"]) == list(exp["best_score"].astype(float))


def test_rank_time_machine_tie_breaks():
    s = pd.DataFrame({"player_id": ["b", "a", "c", "d"], "session_id": ["1", "2", "3", "4"],
                      "score": [10, 10, 10, 5], "fastest_punch": [7, 7, 8, 9], "best_reaction_ms": [200, 200, None, 1]})
    p = pd.DataFrame({"PLAYER_ID": ["a", "b"], "NAME": ["Ann", "Bob"]})
    lb = P.rank_time_machine(s, p)
    assert list(lb["player_id"]) == ["c", "a", "b", "d"] and list(lb["rank"]) == [1, 2, 3, 4]
    assert list(lb["name"]) == ["Unknown", "Ann", "Bob", "Unknown"]
    cmp = P.compare_leaderboards(lb, lb[lb.player_id != "d"].assign(rank=[1, 3, 2]))
    assert list(cmp["movement"]) == ["same", "up 1", "down 1", "new"]
    assert P.rank_time_machine(None, None).empty


def test_time_machine_demo_changes_over_the_hour(lab):
    ev, now = lab["TIME_MACHINE_EVENTS"], lab["now"]
    assert len(P.events_as_of(ev, now)) == len(ev)
    hour_ago = P.events_as_of(ev, now - timedelta(minutes=60))
    assert ev["session_id"].nunique() - hour_ago["session_id"].nunique() == 8


@pytest.mark.parametrize("minutes,expected", [(0, 0), (15, -900), (60, -3600), (999, -3600), (-5, 0), ("x", 0)])
def test_time_travel_offset(minutes, expected):
    assert P.time_travel_offset_s(minutes) == expected


# ---------------------------------------------------------------- highlights / misc demo
def test_highlights_demo_and_shaping(lab):
    feed = P.shape_highlights(lab["V_HIGHLIGHTS_FEED"])
    assert 0 < len(feed) <= 50
    assert set(feed["kind"]) <= set(P.HIGHLIGHT_KINDS) and "suspicious_speed" in set(feed["kind"])
    assert feed["created_at"].is_monotonic_decreasing
    assert all(feed["icon"] != P.DEFAULT_ICON)
    up = P.shape_highlights(pd.DataFrame({"KIND": ["weird"], "CREATED_AT": [datetime(2026, 1, 1)]}))
    assert up.iloc[0]["icon"] == P.DEFAULT_ICON and up.iloc[0]["kind_label"] == "weird"


def test_demo_search_and_crowd(lab):
    res = P.demo_drill_search("keep my hands up", "guard")
    assert not res.empty and set(res["focus"]) == {"guard"}
    assert len(P.demo_drill_search("anything", None, limit=2)) == 2
    text = P.demo_crowd_coach(lab["V_PLAYER_STYLE"])
    assert text.count("\n1. ") == 1 and "Drill for the whole room" in text
    counts = P.task_state_counts(lab["TASK_HISTORY"])
    assert set(counts["name"]) == {"T_HIGHLIGHTS", "T_SCOUTING"}


def test_demo_is_deterministic():
    a, b = P.build_lab_demo(), P.build_lab_demo()
    pd.testing.assert_frame_equal(a["V_HIGHLIGHTS_FEED"], b["V_HIGHLIGHTS_FEED"])
    pd.testing.assert_frame_equal(a["PLAYER_PROGRESS"], b["PLAYER_PROGRESS"])


# ================================================================ AppTest smoke tests
@pytest.fixture
def clean_env(monkeypatch):
    for var in ("MOTION_DEMO", "SNOWFLAKE_MOCK", "SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PASSWORD",
                "SNOWFLAKE_PRIVATE_KEY_PATH", "SNOWFLAKE_AUTHENTICATOR", "SNOWFLAKE_DATABASE", "SNOWFLAKE_SCHEMA"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.delitem(sys.modules, "_snowflake", raising=False)
    st.cache_data.clear()
    st.cache_resource.clear()
    yield monkeypatch
    st.cache_data.clear()
    st.cache_resource.clear()


SECTIONS = ["1. Ask your stats", "2. Live highlights feed", "3. Style twin and scouting",
            "4. Progress across sessions", "5. Punch heatmap", "6. Time machine", "7. Crowd coach", "8. Under the hood"]


def _texts(at):
    out = []
    for kind in ("markdown", "caption", "info", "warning", "error", "code", "header"):
        out += [str(e.value) for e in getattr(at, kind)]
    return "\n".join(out)


def _button(at, label):
    return next(b for b in at.button if b.label == label)


def test_lab_page_demo_mode(clean_env):
    clean_env.setenv("MOTION_DEMO", "1")
    at = AppTest.from_file(PAGE, default_timeout=TIMEOUT).run()
    assert not at.exception, [e.value for e in at.exception]
    assert [h.value for h in at.header] == SECTIONS
    assert len(at.caption) >= len(SECTIONS)
    assert [i.value for i in at.info] == [next(i.value for i in at.info if "DEMO mode" in i.value)]
    assert not at.warning
    for label in ("Similarity to a pro", "Style twin", "Fighting style (AI_CLASSIFY)", "Verdict", "MOTION_WH size"):
        assert label in [m.label for m in at.metric]

    # Cortex Analyst: canned answer via an example button, then a suggestion button
    _button(at, P.DEMO_QUESTIONS[1]).click().run()
    assert not at.exception, [e.value for e in at.exception]
    assert "Cortex Analyst" not in [i.value for i in at.info]
    assert any("AVG(speed_mps)" in c.value for c in at.code)
    assert "Verified query: fastest_punch_type_on_average" in _texts(at)
    sugg = next(b for b in at.button if b.key and b.key.startswith("lab_sugg_"))
    sugg.click().run()
    assert not at.exception
    assert len([c for c in at.code if c.language == "sql"]) == 2

    # time machine, crowd coach, search
    next(s for s in at.slider if s.label == "Minutes ago").set_value(60).run()
    assert not at.exception
    assert "**60 minutes ago**" in _texts(at)
    _button(at, "Coach the room").click().run()
    assert "Drill for the whole room" in _texts(at)
    focus = next(s for s in at.selectbox if s.label == "Focus filter")
    focus.select("guard")
    _button(at, "Search").click().run()
    assert not at.exception, [e.value for e in at.exception]
    assert any("title" in d.value.columns and "Chin-tuck shadow rounds" in set(d.value["title"]) for d in at.dataframe)

    # heatmap toggles
    next(r for r in at.radio if r.label == "Colour").set_value("Avg speed").run()
    next(r for r in at.radio if r.label == "Scope").set_value("All players, all rounds").run()
    assert not at.exception


# ---------------------------------------------------------------- fake Snowflake
class FakeSession:
    """Serves DEMO frames by object name; objects in ``missing`` raise 'does not exist'."""

    def __init__(self, missing=(), time_travel_error=False):
        self.calls = []
        self.lab = P.build_lab_demo()
        self.missing = set(missing)
        self.tt_error = time_travel_error

    def sql(self, query, params=None):
        params = list(params) if params else []
        self.calls.append((query, params))
        assert query.count("?") == len(params), query
        return _Frame(self, query, params)


class _Frame:
    def __init__(self, s, q, p):
        self.s, self.q, self.p = s, q, p

    def limit(self, n):
        return self

    def _df(self):
        lab, q, p = self.s.lab, self.q, self.p
        ds = lab["ds"]
        for obj in self.s.missing:
            if obj in q:
                raise RuntimeError("SQL compilation error: Object 'MOTION_DB.PUBLIC.{}' does not exist or not "
                                   "authorized.".format(obj))
        pid = p[0] if p else None
        sel = lambda df: df[df["player_id"] == pid] if pid else df  # noqa: E731
        if "SEARCH_PREVIEW" in q:
            return pd.DataFrame({"RESULT": [json.dumps({"results": [dict(zip(P.SEARCH_COLUMNS, P.DEMO_DRILLS[0]))]})]})
        if "AI_AGG(" in q:
            return pd.DataFrame({"ANSWER": ["1. Guard drops late. Drill: chin-tuck rounds."]})
        if "DYNAMIC_TABLE_REFRESH_HISTORY" in q:
            return lab["REFRESH_HISTORY"]
        if "TASK_HISTORY" in q:
            return lab["TASK_HISTORY"]
        if q.startswith("SHOW WAREHOUSES"):
            return pd.DataFrame([lab["WAREHOUSE"]])
        if "AT(OFFSET" in q:
            if self.s.tt_error:
                raise RuntimeError("Time travel data is not available for table MOTION_EVENTS.")
            return P.session_scores_from_events(P.events_as_of(lab["TIME_MACHINE_EVENTS"],
                                                               lab["now"] + timedelta(seconds=p[0])))
        if "SUM(COALESCE(e.points" in q:
            return P.session_scores_from_events(lab["TIME_MACHINE_EVENTS"])
        if "FLOOR(offset_ms" in q:
            ev = sel(ds["events"])
            return P.heatmap_agg_from_events(ev)
        m = re.search(r"FROM\s+MOTION_DB\.PUBLIC\.(\w+)", q)
        obj = m.group(1) if m else ""
        frames = {"PLAYERS": lambda: ds["players"], "PRO_BENCHMARKS": lambda: ds["benchmarks"],
                  "V_HIGHLIGHTS_FEED": lambda: lab["V_HIGHLIGHTS_FEED"]}
        for name in ("V_PLAYER_STYLE", "V_STYLE_TWINS", "PLAYER_SCOUTING", "SESSION_SUMMARY", "PLAYER_PROGRESS"):
            frames[name] = (lambda n: lambda: sel(lab[n]).drop(columns=["style_vec"], errors="ignore"))(name)
        if obj not in frames:
            raise AssertionError("unexpected query: " + q)
        return frames[obj]()

    def to_pandas(self):
        df = self._df().reset_index(drop=True).copy()
        df.columns = [str(c).upper() for c in df.columns]
        return df


def _install(monkeypatch, session, analyst=None):
    snowflake = types.ModuleType("snowflake")
    snowpark = types.ModuleType("snowflake.snowpark")
    context = types.ModuleType("snowflake.snowpark.context")
    context.get_active_session = lambda: session
    snowflake.snowpark, snowpark.context = snowpark, context
    monkeypatch.setitem(sys.modules, "snowflake", snowflake)
    monkeypatch.setitem(sys.modules, "snowflake.snowpark", snowpark)
    monkeypatch.setitem(sys.modules, "snowflake.snowpark.context", context)
    mod = types.ModuleType("_snowflake")  # marks the run as Streamlit in Snowflake
    if analyst is not None:
        mod.send_snow_api_request = analyst
    monkeypatch.setitem(sys.modules, "_snowflake", mod)


def test_lab_page_snowflake_path(clean_env):
    session = FakeSession()
    sent = []

    def analyst(method, path, headers, params, body, request_guid, timeout):
        sent.append((method, path, body, timeout))
        msg = {"role": "analyst", "content": [{"type": "text", "text": "Here are the fastest players."},
                                              {"type": "sql", "statement": "SELECT name, avg_speed FROM MOTION_DB.PUBLIC.PLAYERS"},
                                              {"type": "suggestions", "suggestions": ["Who improved most?"]}]}
        return {"status": 200, "content": json.dumps({"message": msg, "request_id": "r1"})}

    _install(clean_env, session, analyst)
    at = AppTest.from_file(PAGE, default_timeout=TIMEOUT).run()
    assert not at.exception, [e.value for e in at.exception]
    assert [h.value for h in at.header] == SECTIONS
    assert not at.info, [i.value for i in at.info]
    assert "Lab data source: snowflake" in _texts(at)

    at.text_input[0].input("Who is fastest?")
    _button(at, "Ask Cortex Analyst").click().run()
    assert not at.exception, [e.value for e in at.exception]
    assert "Here are the fastest players." in _texts(at)
    assert sent[0][:2] == ("POST", P.ANALYST_ENDPOINT) and sent[0][3] == 50000
    assert sent[0][2]["semantic_model_file"] == P.SEMANTIC_MODEL_FILE
    _button(at, "Who improved most?").click().run()
    roles = [m["role"] for m in sent[1][2]["messages"]]
    assert roles == ["user", "analyst", "user"]

    evil = "it's \\ '); DROP TABLE X; --"
    next(t for t in at.text_input if t.label == "Search drills").input(evil)
    _button(at, "Search").click().run()
    _button(at, "Coach the room").click().run()
    next(s for s in at.slider if s.label == "Minutes ago").set_value(30).run()
    assert not at.exception, [e.value for e in at.exception]
    assert "Guard drops late" in _texts(at)

    pid = next(s for s in at.selectbox if s.label.startswith("Player")).value
    for q, _ in session.calls:
        assert pid not in q, "player id must be bound: " + q
    tt = [(q, p) for q, p in session.calls if "AT(OFFSET => ?)" in q]
    assert tt and tt[-1][1] == [-1800]
    search = [q for q, _ in session.calls if "SEARCH_PREVIEW" in q]
    assert search and "DROP TABLE X" in search[-1]  # only inside the escaped literal
    assert "it''s \\\\\\\\ ''); DROP" in search[-1]


def test_lab_page_missing_objects_degrade_to_info(clean_env):
    missing = ["V_HIGHLIGHTS_FEED", "V_PLAYER_STYLE", "V_STYLE_TWINS", "PLAYER_SCOUTING", "SESSION_SUMMARY",
               "PLAYER_PROGRESS", "DYNAMIC_TABLE_REFRESH_HISTORY", "TASK_HISTORY", "SESSIONS"]
    session = FakeSession(missing=missing, time_travel_error=True)
    _install(clean_env, session)  # no _snowflake module: Analyst shows canned answers
    at = AppTest.from_file(PAGE, default_timeout=TIMEOUT).run()
    assert not at.exception, [e.value for e in at.exception]
    assert [h.value for h in at.header] == SECTIONS
    infos = "\n".join(i.value for i in at.info)
    assert "sql/pipelines.sql" in infos and "sql/cortex.sql" in infos
    assert "Time Travel has no data" in infos
    _button(at, "Coach the room").click().run()
    assert not at.exception
    assert "not available yet" in "\n".join(i.value for i in at.info)


def test_runnable_sql_strips_trailing_semicolons_for_snowpark_subquery():
    import plus_logic as P2
    stmt = "SELECT 1 AS x\n -- Generated by Cortex Analyst\n;"
    assert P2.runnable_sql(stmt) == "SELECT 1 AS x\n -- Generated by Cortex Analyst"
    assert P2.runnable_sql("SELECT 2;;  ") == "SELECT 2"
    assert P2.runnable_sql(None) == ""
