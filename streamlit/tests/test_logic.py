"""Unit tests for streamlit/logic.py (no Streamlit, no Snowflake)."""
import json
import time
from datetime import datetime, timedelta
from decimal import Decimal

import pandas as pd
import pytest

import logic as L

SPEED = dict(p25=5.5, p50=7.0, p75=8.5, p90=10.0)  # sql/setup.sql seed
REACTION = dict(p25=210.0, p50=250.0, p75=300.0, p90=360.0)


# ---------------------------------------------------------------- percentile
@pytest.mark.parametrize("value,expected", [(5.5, 25), (7.0, 50), (8.5, 75), (10.0, 90)])
def test_percentile_hits_anchor_points(value, expected):
    assert L.percentile_from_benchmark(value, **SPEED) == expected


def test_percentile_interpolates_between_anchors():
    assert L.percentile_from_benchmark(6.25, **SPEED) == 37.5
    assert L.percentile_from_benchmark(9.25, **SPEED) == 82.5


def test_percentile_extrapolates_and_clamps():
    # below p25 uses the p25-p50 slope: 25 points per 1.5 m/s
    assert L.percentile_from_benchmark(4.75, **SPEED) == 12.5
    assert L.percentile_from_benchmark(0.0, **SPEED) == 1.0  # clamped low
    # above p90 uses the p75-p90 slope: 15 points per 1.5 m/s
    assert L.percentile_from_benchmark(10.5, **SPEED) == 95.0
    assert L.percentile_from_benchmark(50.0, **SPEED) == 99.0  # clamped high


def test_percentile_flips_lower_is_better():
    # setup.sql comment: reaction 210 ms -> 25 -> 100 - 25 = 75th percentile
    assert L.percentile_from_benchmark(210, higher_is_better=False, **REACTION) == 75.0
    assert L.percentile_from_benchmark(250, higher_is_better=False, **REACTION) == 50.0
    assert L.percentile_from_benchmark(1000, higher_is_better=False, **REACTION) == 1.0
    assert L.percentile_from_benchmark(50, higher_is_better=False, **REACTION) == 99.0


def test_percentile_accepts_snowflake_types_and_string_bools():
    assert L.percentile_from_benchmark(Decimal("7.0"), "5.5", 7, 8.5, Decimal("10"), "TRUE") == 50.0
    assert L.percentile_from_benchmark(210, *REACTION.values(), higher_is_better="false") == 75.0


def test_percentile_missing_or_degenerate():
    assert L.percentile_from_benchmark(None, **SPEED) is None
    assert L.percentile_from_benchmark(float("nan"), **SPEED) is None
    assert L.percentile_from_benchmark(7.0, None, 7.0, 8.5, 10.0) is None
    assert L.percentile_from_benchmark(5, 5, 5, 5, 5) == 50.0
    assert L.percentile_from_benchmark(6, 5, 5, 5, 5) == 99.0
    assert L.percentile_from_benchmark(4, 5, 5, 5, 5) == 1.0
    # zero-width first segment still interpolates
    assert L.percentile_from_benchmark(6, 5, 5, 7, 9) == 62.5


def test_percentile_table_uses_benchmarks_and_contract_columns():
    bench = pd.DataFrame(L.DEMO_BENCHMARKS, columns=["SPORT", "METRIC", "P25", "P50", "P75", "P90", "PRO_AVG",
                                                      "HIGHER_IS_BETTER"])
    form = {"avg_speed": 7.0, "avg_reaction_ms": 210, "accuracy_pct": 0.65, "guard_pct": 65,
            "symmetry_pct": None, "fatigue_drop_pct": 8.0}
    t = L.percentile_table(form, bench).set_index("metric")
    assert list(t.index) == L.METRIC_ORDER
    assert t.loc["punch_speed_mps", "percentile"] == 50.0
    assert t.loc["reaction_ms", "percentile"] == 75.0
    assert t.loc["accuracy_pct", "value"] == 65.0  # 0..1 fraction rescaled to the benchmark's 0..100
    assert t.loc["accuracy_pct", "percentile"] == 50.0
    assert pd.isna(t.loc["symmetry_pct", "percentile"])
    assert t.loc["fatigue_drop_pct", "percentile"] == 50.0
    assert not t.loc["fatigue_drop_pct", "higher_is_better"]
    pcts = L.compute_percentiles(form, bench)
    assert pcts["symmetry_pct"] is None and pcts["punch_speed_mps"] == 50.0


def test_percentile_table_without_benchmarks_or_form():
    assert L.percentile_table(None, None).empty
    t = L.percentile_table({"avg_speed": 7}, pd.DataFrame())
    assert t["percentile"].isna().all()


# ---------------------------------------------------------------- leaderboard / stats
def test_shape_leaderboard_normalizes_sorts_and_limits():
    raw = pd.DataFrame({
        "RANK": [3, 1, 2] + list(range(4, 13)),
        "PLAYER_ID": ["c", "a", "b"] + ["x{}".format(i) for i in range(4, 13)],
        "NAME": ["C", "A", None] + ["X"] * 9,
        "SCORE": [10, 30, 20] + [1] * 9,
        "FASTEST_PUNCH": [5.0, 9.0, 7.0] + [1.0] * 9,
        "BEST_REACTION_MS": [300, 200, 250] + [999] * 9,
    })
    lb = L.shape_leaderboard(raw)
    assert list(lb.columns) == L.LEADERBOARD_COLUMNS
    assert len(lb) == 10
    assert list(lb["player_id"][:3]) == ["a", "b", "c"]
    assert lb.loc[1, "name"] == "Unknown"
    assert lb.loc[0, "best_score"] == 30


def test_shape_leaderboard_ranks_by_score_when_rank_missing_and_handles_empty():
    lb = L.shape_leaderboard(pd.DataFrame({"name": ["a", "b"], "best_score": [1, 5]}))
    assert list(lb["name"]) == ["b", "a"] and list(lb["rank"]) == [1, 2]
    assert L.shape_leaderboard(None).empty
    assert list(L.shape_leaderboard(pd.DataFrame()).columns) == L.LEADERBOARD_COLUMNS


def test_demo_live_leaderboard_is_ranked_and_changes_with_tick():
    d = L.build_demo_dataset()
    a = L.demo_live_leaderboard(d["leaderboard"], 0)
    b = L.demo_live_leaderboard(d["leaderboard"], 9)
    for lb in (a, b):
        assert list(lb["rank"]) == list(range(1, len(lb) + 1))
        assert lb["best_score"].is_monotonic_decreasing
        assert "Guest (live)" in set(lb["name"]) and len(lb) <= 10
    score = lambda lb: int(lb.loc[lb["name"] == "Guest (live)", "best_score"].iloc[0])  # noqa: E731
    assert score(b) > score(a)


def test_format_global_stats():
    stats = L.format_global_stats({"total_players": 1234, "total_sessions": 5, "total_punches": None,
                                   "avg_speed": Decimal("6.789"), "max_speed": 11})
    assert stats[0] == ("Players", "1,234")
    assert stats[2][1] == L.EMPTY
    assert stats[3][1] == "6.79 m/s"
    assert len(L.format_global_stats(None)) == 5


def test_first_row_and_normalize():
    assert L.first_row(pd.DataFrame()) is None
    row = L.first_row(pd.DataFrame({"A": [float("nan")], "B": [Decimal("1.5")], "C": ["x"]}))
    assert row == {"a": None, "b": 1.5, "c": "x"}


# ---------------------------------------------------------------- chart shaping
def _sot(rows):
    return pd.DataFrame(rows, columns=["SESSION_ID", "PLAYER_ID", "MINUTE", "SESSION_FIRST_EVENT_TS", "AVG_SPEED"])


def test_speed_over_time_minute_column_orders_and_labels_sessions():
    t0 = datetime(2026, 11, 20, 10)
    rows = []
    for k, sid in enumerate(["s_old", "s_mid", "s_new"]):
        for m in (0.0, 0.167, 0.333):
            rows.append([sid, "p", m, t0 + timedelta(hours=k), 6 + k])
    out = L.shape_speed_over_time(_sot(rows), max_sessions=2)
    assert list(out.columns) == ["session_id", "session_label", "minute", "avg_speed"]
    assert list(pd.unique(out["session_id"])) == ["s_mid", "s_new"]  # chronological, oldest dropped
    assert list(pd.unique(out["session_label"])) == ["Round 1", "Round 2 (latest)"]


def test_speed_over_time_bucket_and_timestamp_inputs():
    by_bucket = pd.DataFrame({"session_id": ["s"] * 3, "bucket": [0, 1, 2], "avg_speed": [5, 6, 7]})
    out = L.shape_speed_over_time(by_bucket)
    assert list(out["minute"].round(3)) == [0.0, 0.167, 0.333]
    t0 = pd.Timestamp("2026-11-21 12:00:00")
    by_ts = pd.DataFrame({"session_id": ["s"] * 2, "bucket_ts": [t0, t0 + pd.Timedelta(seconds=30)],
                          "avg_speed": [5, 6]})
    assert list(L.shape_speed_over_time(by_ts)["minute"]) == [0.0, 0.5]
    assert L.shape_speed_over_time(None).empty
    assert L.shape_speed_over_time(pd.DataFrame({"session_id": ["s"]})).empty


def test_speed_over_time_session_order_override():
    df = pd.DataFrame({"session_id": ["a", "b"], "minute": [0, 0], "avg_speed": [1, 2]})
    out = L.shape_speed_over_time(df, session_order=["a", "b"])  # a is newest
    assert out.iloc[-1]["session_id"] == "a" and out.iloc[-1]["session_label"] == "Round 2 (latest)"


def test_punch_mix_frame():
    mix = L.punch_mix_frame({"mix_jab_pct": 40, "mix_cross_pct": 30, "mix_hook_pct": 20,
                             "mix_uppercut_pct": None, "mix_block_pct": 10})
    assert list(mix["punch_type"]) == L.EVENT_TYPES
    assert list(mix["pct"]) == [40, 30, 20, 0, 10]
    frac = L.punch_mix_frame({"mix_jab_pct": 0.5, "mix_cross_pct": 0.5})
    assert frac["pct"].max() == 50.0
    assert L.punch_mix_frame(None).empty
    assert L.punch_mix_frame({"name": "x"}).empty


def test_shape_fatigue():
    df = pd.DataFrame({"QUARTILE": [4, 2, 1, 3], "AVG_SPEED": [6.0, 7.5, 8.0, 7.0]})
    curve, drop = L.shape_fatigue(df)
    assert list(curve["label"]) == ["Q1", "Q2", "Q3", "Q4"]
    assert drop == 25.0
    _, none_drop = L.shape_fatigue(pd.DataFrame({"quartile": [1, 2], "avg_speed": [8, 7]}))
    assert none_drop is None
    assert L.shape_fatigue(None)[0].empty


def test_shape_lr_matches_player_form_symmetry_definition():
    df = pd.DataFrame({
        "EVENT_TYPE": ["jab", "jab", "hook", "block"],
        "HAND": ["l", "R", "R", "L"],
        "PUNCHES": [30, 50, 20, 99],
        "AVG_SPEED": [6.0, 8.0, 8.0, 0.0],
    })
    frame, s = L.shape_lr(df)
    assert set(frame["punch_type"]) == {"jab", "hook"}  # blocks excluded
    assert len(frame) == 4  # (jab, hook) x (L, R), missing hook-L filled with 0
    assert frame.loc[(frame.punch_type == "hook") & (frame.hand == "L"), "punches"].iloc[0] == 0
    assert (frame.loc[frame.hand == "L", "signed"] <= 0).all()
    assert s["l_punches"] == 30 and s["r_punches"] == 70
    assert s["l_speed"] == 6.0 and s["r_speed"] == 8.0
    # mean of count symmetry (30/70) and speed symmetry (6/8), as in sql/analytics.sql
    assert s["symmetry_pct"] == round((100 * 30 / 70 + 75.0) / 2, 1)


def test_shape_lr_one_handed_and_empty():
    _, s = L.shape_lr(pd.DataFrame({"event_type": ["jab"], "hand": ["R"], "punches": [10], "avg_speed": [7]}))
    assert s["count_symmetry"] == 0.0 and s["speed_symmetry"] == 0.0 and s["symmetry_pct"] == 0.0
    frame, s = L.shape_lr(None)
    assert frame.empty and s["symmetry_pct"] is None


def test_form_score_formula():
    perfect = {"punches": 10, "avg_speed": 10, "avg_reaction_ms": 180, "accuracy_pct": 100, "guard_pct": 100,
               "symmetry_pct": 100, "fatigue_drop_pct": 0}
    assert L.form_score_from_metrics(perfect) == 100.0
    # only speed known: weights re-normalise -> score is the speed component
    assert L.form_score_from_metrics({"punches": 5, "avg_speed": 5}) == 50.0
    assert L.form_score_from_metrics({"punches": 0, "avg_speed": 9}) == 0.0


# ---------------------------------------------------------------- Ask the Coach
def test_sanitize_question():
    assert L.sanitize_question(None) == ""
    assert L.sanitize_question("  hi\x00 there\n\n coach  ") == "hi there coach"
    assert ">>>" not in L.sanitize_question("a >>> b <<< c")
    assert len(L.sanitize_question("x" * 5000)) == L.MAX_QUESTION_CHARS


def test_build_coach_prompt_contains_stats_and_fenced_question():
    form = {"name": "Ada", "avg_speed": 7.123, "form_score": 71.0, "player_id": "secret-id"}
    sessions = pd.DataFrame({"STARTED_AT": [datetime(2026, 11, 21, 10)], "SCORE": [900], "AVG_SPEED": [7.1]})
    p = L.build_coach_prompt("How do I hit harder?'); DROP TABLE x; --", "Ada", form, sessions,
                             {"punch_speed_mps": 55.5, "guard_pct": None})
    assert "<<<\nHow do I hit harder?'); DROP TABLE x; --\n>>>" in p
    assert '"avg_speed":7.12' in p and '"punch_speed_mps":55.5' in p
    assert '"score":900' in p and "2026-11-21 10:00" in p
    assert "secret-id" not in p  # only whitelisted fields
    data = json.loads(p.split("DATA:\n", 1)[1].split("\n", 1)[0])
    assert data["percentiles_vs_pros"] == {"punch_speed_mps": 55.5}  # None percentiles dropped
    assert data["player"] == "Ada" and data["recent_rounds"][0]["score"] == 900


def test_build_coach_prompt_is_capped():
    many = pd.DataFrame({"started_at": ["x" * 80] * 50, "score": list(range(50))})
    p = L.build_coach_prompt("q" * 10000, "N" * 500, {"name": "N"}, many, {}, max_chars=1500)
    assert len(p) <= 1500
    assert p.endswith("Coach's answer:")
    assert "<<<\nhi\n>>>" in L.build_coach_prompt("hi", None, None)


def test_parse_cortex_answer():
    assert L.parse_cortex_answer(None) is None
    assert L.parse_cortex_answer("   ") is None
    assert L.parse_cortex_answer('  "Keep your guard up."  ') == "Keep your guard up."
    js = '{"choices":[{"messages":"Jab more."}],"model":"m"}'
    assert L.parse_cortex_answer(js) == "Jab more."
    long = L.parse_cortex_answer("a" * 10000)
    assert len(long) == L.MAX_ANSWER_CHARS + 3 and long.endswith("...")


def test_call_with_timeout():
    assert L.call_with_timeout(lambda: 42, 1) == (42, None)
    res, err = L.call_with_timeout(lambda: 1 / 0, 1)
    assert res is None and "ZeroDivisionError" in err
    start = time.time()
    res, err = L.call_with_timeout(lambda: time.sleep(2), 0.2)
    assert res is None and "timed out" in err and time.time() - start < 1.5


FORM = {"name": "Ada", "avg_speed": 6.0, "guard_pct": 40.0, "fatigue_drop_pct": 15.0, "form_score": 55.0}
PCTS = {"punch_speed_mps": 40.0, "guard_pct": 5.0, "fatigue_drop_pct": 30.0, "reaction_ms": 80.0}


def test_coach_reply_cortex_success_passes_prompt_to_complete():
    seen = {}

    def fake_complete(prompt):
        seen["prompt"] = prompt
        return "Keep that rear hand at your chin."

    res = L.coach_reply("How is my guard?", "Ada", FORM, None, PCTS, fake_complete, timeout_s=2)
    assert res["source"] == "cortex" and res["error"] is None
    assert res["answer"] == "Keep that rear hand at your chin."
    assert "How is my guard?" in seen["prompt"] and seen["prompt"] == res["prompt"]


@pytest.mark.parametrize("complete", [
    lambda p: (_ for _ in ()).throw(RuntimeError("Cortex model not available in region")),
    lambda p: "",
    lambda p: None,
    lambda p: time.sleep(1.0),
])
def test_coach_reply_falls_back(complete):
    res = L.coach_reply("why am I tired late in the round?", "Ada", FORM, None, PCTS, complete, timeout_s=0.3)
    assert res["source"] == "fallback" and res["error"]
    assert "Endurance" in res["answer"] and "Drill:" in res["answer"]


def test_coach_reply_without_cortex_and_empty_question():
    res = L.coach_reply("tips?", "Ada", FORM, None, PCTS, None)
    assert res["source"] == "fallback" and "Guard discipline" in res["answer"]  # weakest percentile
    assert "Reaction time" in res["answer"]  # strongest percentile
    assert L.coach_reply("   ", "Ada", FORM, None, PCTS, lambda p: "x")["source"] == "invalid"


def test_fallback_answer_without_any_stats():
    text = L.fallback_answer("help", None, None, None)
    assert "champ" in text and "Drill:" in text


def test_choose_model_allowlist():
    assert L.choose_model("llama3.1-70b") == "llama3.1-70b"
    assert L.choose_model("x'); DROP TABLE t; --") == L.DEFAULT_CORTEX_MODEL
    assert L.choose_model(None) == L.DEFAULT_CORTEX_MODEL


# ---------------------------------------------------------------- env / identifiers
def test_session_config_from_env():
    assert L.session_config_from_env({}) is None
    assert L.session_config_from_env({"SNOWFLAKE_ACCOUNT": "a", "SNOWFLAKE_USER": "u"}) is None
    cfg = L.session_config_from_env({"SNOWFLAKE_ACCOUNT": "a", "SNOWFLAKE_USER": "u", "SNOWFLAKE_PASSWORD": "p"})
    assert cfg == {"account": "a", "user": "u", "password": "p", "role": "MOTION_APP_ROLE",
                   "warehouse": "MOTION_WH", "database": "MOTION_DB", "schema": "PUBLIC"}
    key = L.session_config_from_env({"SNOWFLAKE_ACCOUNT": "a", "SNOWFLAKE_USER": "u", "SNOWFLAKE_PASSWORD": "p",
                                     "SNOWFLAKE_PRIVATE_KEY_PATH": "/k.p8",
                                     "SNOWFLAKE_PRIVATE_KEY_PASSPHRASE": "pw", "SNOWFLAKE_ROLE": "R"})
    assert key["private_key_file"] == "/k.p8" and key["private_key_file_pwd"] == "pw"
    assert "password" not in key and key["role"] == "R"
    sso = L.session_config_from_env({"SNOWFLAKE_ACCOUNT": "a", "SNOWFLAKE_USER": "u",
                                     "SNOWFLAKE_AUTHENTICATOR": "externalbrowser"})
    assert sso["authenticator"] == "externalbrowser"


def test_demo_forced():
    assert L.demo_forced({"MOTION_DEMO": "1"}) and L.demo_forced({"SNOWFLAKE_MOCK": "true"})
    assert not L.demo_forced({}) and not L.demo_forced({"MOTION_DEMO": "0"})


def test_identifiers_reject_injection():
    assert L.safe_identifier("motion_db", "X") == "MOTION_DB"
    assert L.safe_identifier("x; drop table y", "MOTION_DB") == "MOTION_DB"
    assert L.safe_identifier('"quoted"', "D") == "D"
    assert L.qualified("motion_db", "public", "V_LEADERBOARD") == "MOTION_DB.PUBLIC.V_LEADERBOARD"
    assert L.qualified("a.b", None, "T") == "MOTION_DB.PUBLIC.T"


def test_ordinal_and_fmt():
    assert [L.ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 99.6)] == [
        "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "100th"]
    assert L.ordinal(None) == L.EMPTY
    assert L.fmt_num(1234.5, 1, " m/s") == "1,234.5 m/s"


# ---------------------------------------------------------------- demo dataset
def test_demo_dataset_is_deterministic_and_consistent():
    a = L.build_demo_dataset(seed=3)
    b = L.build_demo_dataset(seed=3)
    pd.testing.assert_frame_equal(a["player_form"], b["player_form"])
    form = a["player_form"]
    assert set(["player_id", "name", "form_score", "fatigue_drop_pct", "symmetry_pct", "mix_jab_pct"]) <= set(form.columns)
    assert form["form_score"].between(0, 100).all()
    mix_cols = ["mix_{}_pct".format(t) for t in L.EVENT_TYPES]
    assert ((form[mix_cols].sum(axis=1) - 100).abs() < 0.6).all()
    # fatigue_drop_pct in PLAYER_FORM equals Q1->Q4 of V_FATIGUE_CURVE (same as analytics.sql)
    pid = form.loc[0, "player_id"]
    _, drop = L.shape_fatigue(a["fatigue_curve"][a["fatigue_curve"]["player_id"] == pid])
    assert drop == form.loc[0, "fatigue_drop_pct"]
    lb = L.shape_leaderboard(a["leaderboard"])
    assert lb["best_score"].is_monotonic_decreasing and len(lb) == len(L.DEMO_PLAYERS)
    assert a["global_stats"]["total_players"] == len(L.DEMO_PLAYERS)
    pct = L.percentile_table(L.first_row(form), a["benchmarks"])
    assert pct["percentile"].notna().all()
    sot = L.shape_speed_over_time(a["speed_over_time"][a["speed_over_time"]["player_id"] == pid])
    assert not sot.empty and sot["session_label"].iloc[-1].endswith("(latest)")
