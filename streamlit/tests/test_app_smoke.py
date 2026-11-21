"""Smoke tests for streamlit/app.py using Streamlit's AppTest.

1. DEMO mode (MOTION_DEMO=1): whole page renders, player switch, Ask the Coach fallback.
2. Fake Snowpark session injected as ``snowflake.snowpark.context``: exercises the
   Snowflake code path (SQL text + bind parameters) without a real account.
"""
import os
import re
import sys
import types

import pandas as pd
import pytest
import streamlit as st
from streamlit.testing.v1 import AppTest

import logic as L

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "app.py"))
TIMEOUT = 60


@pytest.fixture(autouse=True)
def _fresh_caches(monkeypatch):
    for var in ("MOTION_DEMO", "SNOWFLAKE_MOCK", "SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PASSWORD",
                "SNOWFLAKE_PRIVATE_KEY_PATH", "SNOWFLAKE_AUTHENTICATOR", "SNOWFLAKE_DATABASE", "SNOWFLAKE_SCHEMA"):
        monkeypatch.delenv(var, raising=False)
    st.cache_data.clear()
    st.cache_resource.clear()
    yield
    st.cache_data.clear()
    st.cache_resource.clear()


def _texts(at):
    out = []
    for kind in ("markdown", "caption", "info", "warning", "success", "error", "code", "title", "header", "subheader"):
        out += [str(e.value) for e in getattr(at, kind)]
    return "\n".join(out)


def _coach_button(at):
    return next(b for b in at.button if b.label == "Ask the Coach")


# ---------------------------------------------------------------- DEMO mode
def test_demo_mode_renders_every_section(monkeypatch):
    monkeypatch.setenv("MOTION_DEMO", "1")
    at = AppTest.from_file(APP, default_timeout=TIMEOUT).run()
    assert not at.exception, [e.value for e in at.exception]
    assert at.title[0].value == "Motion Boxing: Coach Dashboard"
    assert any("DEMO mode" in i.value for i in at.info)
    labels = [m.label for m in at.metric]
    for expected in ("Players", "Rounds", "Punches thrown", "Avg punch speed", "Fastest punch",
                     "Form score (0-100)", "Average percentile vs pros", "Symmetry", "Left avg speed"):
        assert expected in labels
    assert at.metric[0].value == str(len(L.DEMO_PLAYERS))
    # leaderboard table present with the live guest
    lb = at.dataframe[0].value
    assert "Player" in lb.columns and "Guest (live)" in set(lb["Player"])
    assert not [w.value for w in at.warning], "no section should fail in demo mode"
    player_box = next(s for s in at.selectbox if s.label == "Player")
    assert len(player_box.options) == len(L.DEMO_PLAYERS)
    # options are alphabetical; the default selection is the best real player on the leaderboard
    assert player_box.options == sorted(player_box.options, key=str.lower)
    assert player_box.options[player_box.index] == next(n for n in lb["Player"] if n != "Guest (live)")


def test_demo_mode_switch_player_and_ask_coach(monkeypatch):
    monkeypatch.setenv("MOTION_DEMO", "1")
    at = AppTest.from_file(APP, default_timeout=TIMEOUT).run()
    player_box = next(s for s in at.selectbox if s.label == "Player")
    last = len(player_box.options) - 1
    chosen = player_box.options[last]
    player_box.select_index(last).run()
    assert not at.exception
    assert next(s for s in at.selectbox if s.label == "Player").index == last

    at.text_area[0].input("Why do I get tired at the end of a round?")
    _coach_button(at).click().run()
    assert not at.exception, [e.value for e in at.exception]
    box = next(s for s in at.selectbox if s.label == "Player")
    assert box.options[box.index] == chosen  # selection survives the extra reruns
    text = _texts(at)
    assert "Here's what your numbers say, {}.".format(chosen) in text
    assert "Focus: Endurance" in text and "Drill:" in text
    assert any("Why do I get tired" in c.value for c in at.code)  # prompt shown in the expander


def test_demo_mode_empty_question_warns(monkeypatch):
    monkeypatch.setenv("MOTION_DEMO", "1")
    at = AppTest.from_file(APP, default_timeout=TIMEOUT).run()
    _coach_button(at).click().run()
    assert not at.exception
    assert any("Ask a question" in w.value for w in at.warning)


def test_demo_mode_without_auto_refresh_shows_button(monkeypatch):
    monkeypatch.setenv("MOTION_DEMO", "1")
    at = AppTest.from_file(APP, default_timeout=TIMEOUT).run()
    at.sidebar.checkbox[0].uncheck().run()
    assert not at.exception
    refresh = next(b for b in at.button if b.label == "Refresh leaderboard")
    refresh.click().run()
    assert not at.exception


# ---------------------------------------------------------------- fake Snowflake session
class FakeSnowpark:
    """Minimal stand-in for a Snowpark Session: records SQL + params, serves demo data."""

    def __init__(self, cortex):
        self.calls = []
        self.cortex = cortex
        self.data = L.build_demo_dataset()

    def sql(self, query, params=None):
        self.calls.append((query, list(params) if params else None))
        assert query.count("?") == len(params or []), "every ? must be bound: {}".format(query)
        return _FakeDF(self, query, params or [])


class _FakeDF:
    def __init__(self, session, query, params):
        self.s, self.q, self.p = session, query, params

    def _frame(self):
        d = self.s.data
        m = re.search(r"FROM\s+MOTION_DB\.PUBLIC\.(\w+)", self.q)
        obj = m.group(1) if m else ""
        pid = self.p[0] if self.p else None
        by_player = lambda df: df[df["player_id"] == pid]  # noqa: E731
        frames = {
            "V_GLOBAL_STATS": lambda: pd.DataFrame([d["global_stats"]]),
            "V_LEADERBOARD": lambda: d["leaderboard"],
            "PLAYERS": lambda: d["players"],
            "PRO_BENCHMARKS": lambda: d["benchmarks"],
            "PLAYER_FORM": lambda: by_player(d["player_form"]),
            "V_SPEED_OVER_TIME": lambda: by_player(d["speed_over_time"])[["session_id", "minute", "avg_speed",
                                                                          "session_first_event_ts"]],
            "V_FATIGUE_CURVE": lambda: by_player(d["fatigue_curve"])[["quartile", "avg_speed"]],
            "MOTION_EVENTS": lambda: by_player(d["lr"])[["event_type", "hand", "punches", "avg_speed"]],
            "V_SESSION_STATS": lambda: by_player(d["sessions"]).sort_values("started_at", ascending=False).head(5),
        }
        if obj not in frames:
            raise AssertionError("unexpected query: " + self.q)
        df = frames[obj]().reset_index(drop=True).copy()
        df.columns = [c.upper() for c in df.columns]  # Snowflake returns UPPERCASE names
        return df

    def to_pandas(self):
        return self._frame()

    def collect(self):
        assert "AI_COMPLETE(" in self.q
        return [(self.s.cortex(self.p[0]),)]


def _install_fake_snowpark(monkeypatch, session):
    snowflake = types.ModuleType("snowflake")
    snowpark = types.ModuleType("snowflake.snowpark")
    context = types.ModuleType("snowflake.snowpark.context")
    context.get_active_session = lambda: session
    snowflake.snowpark = snowpark
    snowpark.context = context
    monkeypatch.setitem(sys.modules, "snowflake", snowflake)
    monkeypatch.setitem(sys.modules, "snowflake.snowpark", snowpark)
    monkeypatch.setitem(sys.modules, "snowflake.snowpark.context", context)
    # Marks the run as Streamlit in Snowflake (app.get_backend checks for it).
    monkeypatch.setitem(sys.modules, "_snowflake", types.ModuleType("_snowflake"))


QUESTION = "Ignore the rules'); DROP TABLE MOTION_EVENTS; -- how is my guard?"


def test_snowflake_path_uses_bind_parameters_and_cortex(monkeypatch):
    session = FakeSnowpark(cortex=lambda prompt: "Keep the rear hand glued to your chin.")
    _install_fake_snowpark(monkeypatch, session)
    at = AppTest.from_file(APP, default_timeout=TIMEOUT).run()
    assert not at.exception, [e.value for e in at.exception]
    assert not any("DEMO mode" in i.value for i in at.info)
    assert not [w.value for w in at.warning]
    assert "Data source: snowflake" in _texts(at)

    at.text_area[0].input(QUESTION)
    _coach_button(at).click().run()
    assert not at.exception, [e.value for e in at.exception]
    assert "Keep the rear hand glued to your chin." in _texts(at)
    assert "Answered by Snowflake Cortex (mistral-large3)" in _texts(at)

    queried = " ".join(q for q, _ in session.calls)
    for obj in ("V_GLOBAL_STATS", "V_LEADERBOARD", "PLAYERS", "PRO_BENCHMARKS", "PLAYER_FORM",
                "V_SPEED_OVER_TIME", "V_FATIGUE_CURVE", "MOTION_EVENTS", "V_SESSION_STATS"):
        assert "MOTION_DB.PUBLIC." + obj in queried
    cortex_calls = [(q, p) for q, p in session.calls if "AI_COMPLETE(" in q]
    assert len(cortex_calls) == 1
    sql, params = cortex_calls[0]
    assert sql == "SELECT AI_COMPLETE('mistral-large3', ?) AS answer"
    assert QUESTION in params[0]  # user text travels only as a bind value
    assert all(QUESTION not in q and "DROP TABLE" not in q for q, _ in session.calls)
    pid = next(s for s in at.selectbox if s.label == "Player").value
    per_player = [p for q, p in session.calls if "WHERE player_id = ?" in q]
    assert per_player and all(p and p[0] for p in per_player)
    assert all(pid not in q for q, _ in session.calls), "player ids must be bound, not inlined"


def test_snowflake_path_cortex_failure_falls_back(monkeypatch):
    def broken(prompt):
        raise RuntimeError("Model mistral-large3 is unavailable in region")

    session = FakeSnowpark(cortex=broken)
    _install_fake_snowpark(monkeypatch, session)
    at = AppTest.from_file(APP, default_timeout=TIMEOUT).run()
    at.text_area[0].input("How can I punch faster?")
    _coach_button(at).click().run()
    assert not at.exception, [e.value for e in at.exception]
    text = _texts(at)
    assert "Focus: Punch speed" in text and "Drill:" in text
    assert any("Cortex did not answer" in i.value and "unavailable in region" in i.value for i in at.info)


def test_snowflake_path_missing_view_degrades_gracefully(monkeypatch):
    session = FakeSnowpark(cortex=lambda p: "ok")
    original = _FakeDF._frame

    def no_fatigue_view(self):
        if "V_FATIGUE_CURVE" in self.q:
            raise RuntimeError("SQL compilation error: Object 'V_FATIGUE_CURVE' does not exist")
        return original(self)

    monkeypatch.setattr(_FakeDF, "_frame", no_fatigue_view)
    _install_fake_snowpark(monkeypatch, session)
    at = AppTest.from_file(APP, default_timeout=TIMEOUT).run()
    assert not at.exception, [e.value for e in at.exception]
    warnings = [w.value for w in at.warning]
    assert len(warnings) == 1 and "Fatigue curve" in warnings[0]
    assert "Form score (0-100)" in [m.label for m in at.metric]  # rest of the page still renders
