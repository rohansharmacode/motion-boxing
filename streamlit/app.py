"""Motion Boxing: coach dashboard for Streamlit in Snowflake (SiS).

Data source, in order of preference:
  1. Streamlit in Snowflake: ``snowflake.snowpark.context.get_active_session()``
  2. Local dev: a Snowpark session built from SNOWFLAKE_* env vars
     (see ``logic.session_config_from_env``)
  3. DEMO: deterministic synthetic data (``logic.build_demo_dataset``); also forced
     with MOTION_DEMO=1 or SNOWFLAKE_MOCK=1.

All table / view names come from sql/CONTRACT.md. Every query that takes a value
uses Snowpark bind parameters (``?``); user text never goes into SQL text.
Pure logic (shaping, percentiles, prompt, fallback) lives in logic.py.
"""
from __future__ import annotations

import inspect
import os
import sys
import time
from datetime import datetime
from typing import Any, Callable, Dict, Optional, Sequence

import altair as alt
import pandas as pd
import streamlit as st

try:  # make the sibling module importable however the app is launched
    _HERE = os.path.dirname(os.path.abspath(__file__))
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
except NameError:  # pragma: no cover - __file__ always exists under Streamlit
    pass

import logic as L  # noqa: E402

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
DB = L.safe_identifier(os.environ.get("SNOWFLAKE_DATABASE"), "MOTION_DB")
SCHEMA = L.safe_identifier(os.environ.get("SNOWFLAKE_SCHEMA"), "PUBLIC")
REFRESH_CHOICES = [5, 10, 30]
DEFAULT_REFRESH_S = 10

# Reference palette (dataviz skill): slot 1 blue, slot 2 orange, recessive grays.
BLUE = "#2a78d6"
ORANGE = "#eb6834"
GRAY = "#b9b8b0"
MUTED = "#898781"


def T(name: str) -> str:
    """Fully-qualified object name, e.g. MOTION_DB.PUBLIC.V_LEADERBOARD."""
    return L.qualified(DB, SCHEMA, name)


# ---------------------------------------------------------------------------
# Streamlit version compatibility (SiS offers 1.22 .. 1.52)
# ---------------------------------------------------------------------------
def _params_of(fn: Callable[..., Any]) -> Dict[str, inspect.Parameter]:
    try:
        return dict(inspect.signature(fn).parameters)
    except (TypeError, ValueError):
        return {}


def show_chart(chart: Any) -> None:
    params = _params_of(st.altair_chart)
    if "width" in params:
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


def rerun() -> None:
    fn = getattr(st, "rerun", None) or getattr(st, "experimental_rerun", None)
    if fn is not None:
        fn()


def auto_refresh_decorator(seconds: int) -> Optional[Callable[[Callable[[], None]], Callable[[], None]]]:
    """st.fragment(run_every=...) on >= 1.37, st.experimental_fragment on 1.33-1.36, else None."""
    frag = getattr(st, "fragment", None) or getattr(st, "experimental_fragment", None)
    if frag is None:
        return None
    try:
        return frag(run_every=seconds)
    except TypeError:
        return None


def short_error(exc: BaseException) -> str:
    text = " ".join(str(exc).split())
    return "{}: {}".format(type(exc).__name__, text[:200])


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------
class Backend:
    def __init__(self, mode: str, session: Any = None, detail: str = "") -> None:
        self.mode = mode  # "snowflake" | "local" | "demo"
        self.session = session
        self.detail = detail

    @property
    def is_demo(self) -> bool:
        return self.mode == "demo"


@st.cache_resource(show_spinner=False)
def get_backend() -> Backend:
    env = os.environ
    if L.demo_forced(env):
        return Backend("demo", detail="MOTION_DEMO / SNOWFLAKE_MOCK is set")
    try:
        from snowflake.snowpark.context import get_active_session

        return Backend("snowflake", get_active_session(), "Streamlit in Snowflake session")
    except Exception:  # noqa: BLE001 - not running in SiS (or Snowpark missing)
        pass
    cfg = L.session_config_from_env(env)
    if cfg is None:
        return Backend("demo", detail="no Snowflake session and no SNOWFLAKE_* credentials in the environment")
    try:
        from snowflake.snowpark import Session

        session = Session.builder.configs(cfg).create()
        return Backend("local", session, "local Snowpark session as {} ({})".format(cfg["user"], cfg["account"]))
    except Exception as exc:  # noqa: BLE001
        return Backend("demo", detail="local Snowflake connection failed ({})".format(short_error(exc)))


@st.cache_resource(show_spinner=False)
def demo_dataset() -> Dict[str, Any]:
    return L.build_demo_dataset()


def _run_sql(sql: str, params: Sequence[Any]) -> pd.DataFrame:
    session = get_backend().session
    df = session.sql(sql, params=list(params) if params else None).to_pandas()
    return L.normalize_columns(df)


# Short TTLs: the leaderboard is "live"; PLAYER_FORM itself only refreshes ~1/min.
@st.cache_data(ttl=4, show_spinner=False)
def q_live(sql: str, params: tuple = ()) -> pd.DataFrame:
    return _run_sql(sql, params)


@st.cache_data(ttl=30, show_spinner=False)
def q_player(sql: str, params: tuple = ()) -> pd.DataFrame:
    return _run_sql(sql, params)


@st.cache_data(ttl=600, show_spinner=False)
def q_static(sql: str, params: tuple = ()) -> pd.DataFrame:
    return _run_sql(sql, params)


# ---------------------------------------------------------------------------
# Data facade: identical API for Snowflake and DEMO
# ---------------------------------------------------------------------------
class Data:
    def __init__(self, backend: Backend, refresh_s: int = DEFAULT_REFRESH_S) -> None:
        self.backend = backend
        self.refresh_s = refresh_s

    @property
    def demo(self) -> Dict[str, Any]:
        return demo_dataset()

    def _demo_rows(self, key: str, player_id: str) -> pd.DataFrame:
        df = self.demo[key]
        return df[df["player_id"] == player_id].reset_index(drop=True)

    # --- live ---------------------------------------------------------------
    def global_stats(self) -> Optional[Dict[str, Any]]:
        if self.backend.is_demo:
            return dict(self.demo["global_stats"])
        return L.first_row(q_live("SELECT * FROM {}".format(T("V_GLOBAL_STATS"))))

    def leaderboard(self) -> pd.DataFrame:
        if self.backend.is_demo:
            tick = int(time.time() // max(1, self.refresh_s))
            return L.demo_live_leaderboard(self.demo["leaderboard"], tick)
        return L.shape_leaderboard(q_live("SELECT * FROM {} ORDER BY rank".format(T("V_LEADERBOARD"))))

    # --- reference ----------------------------------------------------------
    def players(self) -> pd.DataFrame:
        if self.backend.is_demo:
            return self.demo["players"][["player_id", "name"]]
        return q_player(
            "SELECT player_id, COALESCE(MAX(name), 'Unknown') AS name, MAX(created_at) AS created_at "
            "FROM {} WHERE player_id IS NOT NULL GROUP BY player_id "
            "ORDER BY created_at DESC NULLS LAST LIMIT 500".format(T("PLAYERS"))
        )

    def benchmarks(self) -> pd.DataFrame:
        if self.backend.is_demo:
            return self.demo["benchmarks"]
        return q_static("SELECT * FROM {} WHERE LOWER(sport) = 'boxing'".format(T("PRO_BENCHMARKS")))

    # --- per player (player_id is always a bind parameter) -------------------
    def form(self, player_id: str) -> Optional[Dict[str, Any]]:
        if self.backend.is_demo:
            return L.first_row(self._demo_rows("player_form", player_id))
        return L.first_row(q_player("SELECT * FROM {} WHERE player_id = ?".format(T("PLAYER_FORM")), (player_id,)))

    def speed_over_time(self, player_id: str) -> pd.DataFrame:
        if self.backend.is_demo:
            return self._demo_rows("speed_over_time", player_id)
        return q_player(
            "SELECT session_id, minute, avg_speed, session_first_event_ts FROM {} WHERE player_id = ? "
            "QUALIFY DENSE_RANK() OVER (ORDER BY session_first_event_ts DESC, session_id) <= 5 "
            "ORDER BY session_first_event_ts, minute".format(T("V_SPEED_OVER_TIME")),
            (player_id,),
        )

    def fatigue(self, player_id: str) -> pd.DataFrame:
        if self.backend.is_demo:
            return self._demo_rows("fatigue_curve", player_id)
        return q_player(
            "SELECT quartile, avg_speed FROM {} WHERE player_id = ? ORDER BY quartile".format(T("V_FATIGUE_CURVE")),
            (player_id,),
        )

    def lr_split(self, player_id: str) -> pd.DataFrame:
        if self.backend.is_demo:
            return self._demo_rows("lr", player_id)
        return q_player(
            "SELECT LOWER(event_type) AS event_type, UPPER(hand) AS hand, COUNT(*) AS punches, "
            "AVG(speed_mps) AS avg_speed FROM {} WHERE player_id = ? "
            "AND LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut') "
            "GROUP BY 1, 2".format(T("MOTION_EVENTS")),
            (player_id,),
        )

    def recent_sessions(self, player_id: str) -> pd.DataFrame:
        if self.backend.is_demo:
            df = self._demo_rows("sessions", player_id)
            return df.sort_values("started_at", ascending=False).head(5).reset_index(drop=True)
        sql = ("SELECT * FROM {} WHERE player_id = ? "
               "ORDER BY started_at DESC NULLS LAST LIMIT 5")
        try:  # live aggregates (works for rounds that have not ended yet)
            return q_player(sql.format(T("V_SESSION_STATS")), (player_id,))
        except Exception:  # noqa: BLE001 - fall back to the summary columns
            return q_player(sql.format(T("SESSIONS")), (player_id,))

    # --- Cortex ---------------------------------------------------------------
    def complete_fn(self, model: str) -> Optional[Callable[[str], Any]]:
        """Returns prompt -> answer, or None when Cortex is not reachable (DEMO)."""
        if self.backend.is_demo or self.backend.session is None:
            return None
        session = self.backend.session  # captured here: the call runs in a worker thread
        model = L.choose_model(model)  # allow-listed literal; the prompt is a bind parameter
        sql = "SELECT SNOWFLAKE.CORTEX.COMPLETE('{}', ?) AS answer".format(model)

        def _complete(prompt: str) -> Any:
            rows = session.sql(sql, params=[prompt]).collect()
            return rows[0][0] if rows else None

        return _complete


def safe(label: str, fn: Callable[[], Any], default: Any) -> Any:
    """Run a loader; on error show a small warning and keep the rest of the page alive."""
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        st.warning("{} unavailable: {}".format(label, short_error(exc)))
        return default


# ---------------------------------------------------------------------------
# Charts (Altair 4 and 5 compatible)
# ---------------------------------------------------------------------------
def speed_chart(df: pd.DataFrame) -> alt.Chart:
    data = df.copy()
    latest = data["session_label"].iloc[-1]
    data["series"] = data["session_label"].map(lambda s: "Latest round" if s == latest else "Earlier rounds")
    base = alt.Chart(data).encode(
        x=alt.X("minute:Q", title="Minutes into round"),
        y=alt.Y("avg_speed:Q", title="Avg punch speed (m/s)", scale=alt.Scale(zero=False)),
        color=alt.Color("series:N", title=None,
                        scale=alt.Scale(domain=["Latest round", "Earlier rounds"], range=[BLUE, GRAY]),
                        legend=alt.Legend(orient="bottom")),
        detail="session_label:N",
        tooltip=[alt.Tooltip("session_label:N", title="Round"),
                 alt.Tooltip("minute:Q", title="Minute", format=".2f"),
                 alt.Tooltip("avg_speed:Q", title="Avg speed (m/s)", format=".2f")],
    )
    lines = base.mark_line().encode(
        strokeWidth=alt.condition(alt.datum.series == "Latest round", alt.value(2.5), alt.value(1.25)))
    points = base.transform_filter(alt.datum.series == "Latest round").mark_point(filled=True, size=36)
    return (lines + points).properties(height=280)


def mix_chart(df: pd.DataFrame) -> alt.Chart:
    order = list(df["punch_type"])
    base = alt.Chart(df).encode(
        y=alt.Y("punch_type:N", sort=order, title=None),
        x=alt.X("pct:Q", title="Share of actions (%)",
                scale=alt.Scale(domain=[0, max(10.0, float(df["pct"].max()) * 1.15)])),
        tooltip=[alt.Tooltip("punch_type:N", title="Type"), alt.Tooltip("pct:Q", title="Share (%)", format=".1f")],
    )
    bars = base.mark_bar(color=BLUE, size=18)
    labels = base.mark_text(align="left", dx=4, color=MUTED).encode(text=alt.Text("pct:Q", format=".0f"))
    return (bars + labels).properties(height=220)


def fatigue_chart(df: pd.DataFrame) -> alt.Chart:
    base = alt.Chart(df).encode(
        x=alt.X("label:O", title="Quarter of the round", sort=["Q1", "Q2", "Q3", "Q4"],
                axis=alt.Axis(labelAngle=0)),
        y=alt.Y("avg_speed:Q", title="Avg punch speed (m/s)", scale=alt.Scale(zero=False)),
        tooltip=[alt.Tooltip("label:O", title="Quarter"), alt.Tooltip("avg_speed:Q", title="Avg speed (m/s)", format=".2f")],
    )
    return (base.mark_line(color=BLUE, strokeWidth=2) + base.mark_point(color=BLUE, filled=True, size=64)).properties(height=240)


def lr_chart(df: pd.DataFrame) -> alt.Chart:
    data = df.copy()
    data["side"] = data["hand"].map({"L": "Left", "R": "Right"})
    order = [t for t in L.PUNCH_TYPES if t in set(data["punch_type"])]
    bars = alt.Chart(data).mark_bar(size=16).encode(
        y=alt.Y("punch_type:N", sort=order, title=None),
        x=alt.X("signed:Q", title="Punches  (left hand  |  right hand)",
                axis=alt.Axis(labelExpr="abs(datum.value)")),
        color=alt.Color("side:N", title=None, scale=alt.Scale(domain=["Left", "Right"], range=[BLUE, ORANGE]),
                        legend=alt.Legend(orient="bottom")),
        tooltip=[alt.Tooltip("side:N", title="Hand"), alt.Tooltip("punch_type:N", title="Punch"),
                 alt.Tooltip("punches:Q", title="Punches"),
                 alt.Tooltip("avg_speed:Q", title="Avg speed (m/s)", format=".2f")],
    )
    zero = alt.Chart(pd.DataFrame({"x": [0]})).mark_rule(color=MUTED).encode(x="x:Q")
    return (bars + zero).properties(height=220)


def percentile_chart(df: pd.DataFrame) -> alt.Chart:
    data = df.dropna(subset=["percentile"]).copy()
    data["value_txt"] = data.apply(
        lambda r: "{} {}".format(L.fmt_num(r["value"], 1), r["unit"]).strip(), axis=1)
    order = [L.METRIC_LABELS[m] for m in L.METRIC_ORDER]
    base = alt.Chart(data).encode(
        y=alt.Y("label:N", sort=order, title=None),
        x=alt.X("percentile:Q", title="Percentile vs pro benchmarks (higher is better)",
                scale=alt.Scale(domain=[0, 100])),
        tooltip=[alt.Tooltip("label:N", title="Metric"), alt.Tooltip("value_txt:N", title="You"),
                 alt.Tooltip("pro_median:Q", title="Pro median (p50)", format=".1f"),
                 alt.Tooltip("pro_avg:Q", title="Pro average", format=".1f"),
                 alt.Tooltip("percentile:Q", title="Percentile", format=".0f")],
    )
    bars = base.mark_bar(color=BLUE, size=16)
    labels = base.mark_text(align="left", dx=4, color=MUTED).encode(text=alt.Text("percentile:Q", format=".0f"))
    median = alt.Chart(pd.DataFrame({"x": [50]})).mark_rule(color=MUTED, strokeWidth=1).encode(x="x:Q")
    return (bars + labels + median).properties(height=240)


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------
def render_global_stats(data: Data) -> None:
    row = safe("Global stats (V_GLOBAL_STATS)", data.global_stats, None)
    cols = st.columns(5)
    for col, (label, value) in zip(cols, L.format_global_stats(row)):
        col.metric(label, value)


def render_leaderboard(data: Data) -> None:
    lb = safe("Leaderboard (V_LEADERBOARD)", data.leaderboard, L.shape_leaderboard(None))
    if lb.empty:
        st.info("No rounds yet. Box a round in the game and the leaderboard fills in here.")
        return
    view = lb.rename(columns={"rank": "#", "name": "Player", "best_score": "Best score",
                              "fastest_punch": "Fastest punch (m/s)", "best_reaction_ms": "Best reaction (ms)"})
    show_table(view[["#", "Player", "Best score", "Fastest punch (m/s)", "Best reaction (ms)"]])
    st.caption("Updated {}".format(datetime.now().strftime("%H:%M:%S")))


def render_live_section(data: Data, auto: bool) -> None:
    def body() -> None:
        render_global_stats(data)
        st.subheader("Live leaderboard")
        render_leaderboard(data)

    deco = auto_refresh_decorator(data.refresh_s) if auto else None
    if deco is not None:
        deco(body)()
        return
    body()
    if auto:
        st.caption("Auto-refresh needs Streamlit 1.33+; use the button instead.")
    if st.button("Refresh leaderboard"):
        q_live.clear()
        rerun()


def pick_player(data: Data) -> Optional[Dict[str, Any]]:
    players = safe("Players (PLAYERS)", data.players, pd.DataFrame(columns=["player_id", "name"]))
    players = L.normalize_columns(players)
    if players.empty:
        st.info("No players yet.")
        return None
    names = dict(zip(players["player_id"].astype(str), players["name"].fillna("Unknown").astype(str)))
    # Stable (alphabetical) options + the selection remembered in session_state, so a
    # leaderboard reshuffle or a new player never silently switches the selected player.
    options = sorted(names, key=lambda p: (names[p].lower(), p))
    selected = st.session_state.get("selected_player_id")
    if selected not in names:  # first visit: default to the current leaderboard #1
        lb = safe("Leaderboard (V_LEADERBOARD)", data.leaderboard, L.shape_leaderboard(None))
        selected = next((str(p) for p in lb["player_id"] if str(p) in names), options[0])
    counts = pd.Series(list(names.values())).value_counts()
    dup = set(counts[counts > 1].index)

    def label(pid: str) -> str:
        n = names.get(pid, pid)
        return "{} ({})".format(n, pid[:6]) if n in dup else n

    pid = st.selectbox("Player", options, index=options.index(selected), format_func=label)
    st.session_state["selected_player_id"] = pid
    return {"player_id": pid, "name": names.get(pid, "Unknown")}


def render_form(form: Optional[Dict[str, Any]], pct_table: pd.DataFrame) -> None:
    left, right = st.columns([1, 2])
    with left:
        st.markdown("**Form score**")
        if not form:
            st.info("No form yet. PLAYER_FORM is a dynamic table that refreshes about once a minute "
                    "after the first punches land.")
            return
        score = L.to_float(form.get("form_score")) or 0.0
        st.metric("Form score (0-100)", "{:.0f}".format(score))
        st.progress(int(L.clamp(round(score), 0, 100)))
        pcts = pct_table["percentile"].dropna()
        if not pcts.empty:
            st.metric("Average percentile vs pros", L.ordinal(pcts.mean()))
        st.caption("{} rounds, {} punches".format(L.fmt_num(form.get("sessions")), L.fmt_num(form.get("punches"))))
    with right:
        st.markdown("**Percentile vs PRO_BENCHMARKS**")
        if pct_table["percentile"].dropna().empty:
            st.info("No benchmark comparison available yet.")
        else:
            show_chart(percentile_chart(pct_table))
            st.caption("Grey line = pro median (50th percentile). Reaction time and fatigue drop are "
                       "lower-is-better, so they are flipped: a higher bar is always better.")
            with st.expander("Table view"):
                tbl = pct_table.rename(columns={"label": "Metric", "unit": "Unit", "value": "You",
                                                "pro_median": "Pro median", "pro_avg": "Pro avg",
                                                "percentile": "Percentile"})
                show_table(tbl[["Metric", "You", "Unit", "Pro median", "Pro avg", "Percentile"]])


def render_player_charts(data: Data, player_id: str, form: Optional[Dict[str, Any]]) -> None:
    c1, c2 = st.columns(2)
    with c1:
        st.markdown("**Punch speed over time** (last 5 rounds)")
        sot = L.shape_speed_over_time(safe("Speed over time (V_SPEED_OVER_TIME)",
                                           lambda: data.speed_over_time(player_id), None))
        if sot.empty:
            st.info("No punches recorded yet.")
        else:
            show_chart(speed_chart(sot))
    with c2:
        st.markdown("**Punch-type mix**")
        mix = L.punch_mix_frame(form)
        if mix.empty:
            st.info("No punch mix yet.")
        else:
            show_chart(mix_chart(mix))

    c3, c4 = st.columns(2)
    with c3:
        st.markdown("**Fatigue curve** (avg speed per quarter of a round)")
        curve, drop = L.shape_fatigue(safe("Fatigue curve (V_FATIGUE_CURVE)", lambda: data.fatigue(player_id), None))
        if curve.empty:
            st.info("Needs a round with at least 8 punches.")
        else:
            show_chart(fatigue_chart(curve))
            if drop is not None:
                verdict = "slower" if drop > 0 else "faster"
                st.caption("Q4 is {:.1f}% {} than Q1.".format(abs(drop), verdict))
    with c4:
        st.markdown("**Left / right symmetry**")
        lr, summary = L.shape_lr(safe("L/R split (MOTION_EVENTS)", lambda: data.lr_split(player_id), None))
        sym = L.to_float((form or {}).get("symmetry_pct"))
        if sym is None:
            sym = summary.get("symmetry_pct")
        m1, m2, m3 = st.columns(3)
        m1.metric("Symmetry", L.fmt_num(sym, 0, " / 100"))
        m2.metric("Left avg speed", L.fmt_num(summary.get("l_speed"), 2, " m/s"))
        m3.metric("Right avg speed", L.fmt_num(summary.get("r_speed"), 2, " m/s"))
        if lr.empty:
            st.info("No punches recorded yet.")
        else:
            show_chart(lr_chart(lr))


def render_coach(data: Data, player: Dict[str, Any], form: Optional[Dict[str, Any]],
                 pcts: Dict[str, Optional[float]], model: str) -> None:
    st.subheader("Ask the Coach")
    if data.backend.is_demo:
        st.caption("DEMO mode: Cortex is not reachable, so the coach answers with a canned reply built from the stats.")
    else:
        st.caption("Your question plus this player's PLAYER_FORM row and last 5 rounds go to "
                   "SNOWFLAKE.CORTEX.COMPLETE ({}).".format(L.choose_model(model)))
    pid = player["player_id"]
    with st.form("coach_form"):
        question = st.text_area("Question", max_chars=L.MAX_QUESTION_CHARS,
                                placeholder="e.g. Why does my speed drop at the end of a round?")
        submitted = st.form_submit_button("Ask the Coach")
    state_key = "coach_answer_{}".format(pid)
    if submitted:
        recent = safe("Recent rounds", lambda: data.recent_sessions(pid), None)
        with st.spinner("The coach is reviewing your stats..."):
            st.session_state[state_key] = L.coach_reply(
                question, player["name"], form, recent, pcts, data.complete_fn(model), timeout_s=L.COACH_TIMEOUT_S)
    res = st.session_state.get(state_key)
    if not res:
        return
    if res["source"] == "invalid":
        st.warning(res["answer"])
        return
    st.markdown(res["answer"])
    if res["source"] == "cortex":
        st.caption("Answered by Snowflake Cortex ({}).".format(L.choose_model(model)))
    elif not data.backend.is_demo:
        st.info("Cortex did not answer ({}), so this is the built-in coach reply.".format(res.get("error") or "unknown"))
    if res.get("prompt"):
        with st.expander("What the coach was given"):
            st.code(res["prompt"], language="text")


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------
def main() -> None:
    try:  # SiS ignores page_title/page_icon; layout works everywhere
        st.set_page_config(layout="wide")
    except Exception:  # noqa: BLE001
        pass

    backend = get_backend()
    with st.sidebar:
        st.header("Settings")
        auto = st.checkbox("Auto-refresh leaderboard", value=True)
        refresh_s = st.selectbox("Refresh every", REFRESH_CHOICES, index=REFRESH_CHOICES.index(DEFAULT_REFRESH_S),
                                 format_func=lambda s: "{} s".format(s))
        model = st.selectbox("Cortex model", L.CORTEX_MODELS, index=0)
        if st.button("Clear cached data"):
            st.cache_data.clear()
        st.caption("Data source: {} ({})".format(backend.mode, backend.detail))
        if not backend.is_demo:
            st.caption("Objects: {}.{}".format(DB, SCHEMA))

    data = Data(backend, refresh_s=refresh_s)

    st.title("Motion Boxing: Coach Dashboard")
    if backend.is_demo:
        st.info("DEMO mode: synthetic players and rounds, no Snowflake connection ({}).".format(backend.detail))
    else:
        st.caption("Live from Snowflake: every punch is a row in MOTION_EVENTS; PLAYER_FORM is a dynamic "
                   "table with a 1-minute target lag.")

    render_live_section(data, auto)

    st.markdown("---")
    st.header("Player")
    player = pick_player(data)
    if player is None:
        return
    pid = player["player_id"]
    form = safe("Player form (PLAYER_FORM)", lambda: data.form(pid), None)
    bench = safe("Benchmarks (PRO_BENCHMARKS)", data.benchmarks, pd.DataFrame())
    pct_table = L.percentile_table(form, bench)
    pcts = {r["metric"]: L.to_float(r["percentile"]) for r in pct_table.to_dict("records")}

    render_form(form, pct_table)
    render_player_charts(data, pid, form)
    st.markdown("---")
    render_coach(data, player, form, pcts, model)


main()
