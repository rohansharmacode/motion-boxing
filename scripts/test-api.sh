#!/usr/bin/env bash
# End-to-end API check. Usage: BASE_URL=http://localhost:3001 ./test-api.sh   (or pass URL as $1)
BASE_URL="${1:-${BASE_URL:-http://localhost:3001}}"
BASE_URL="${BASE_URL%/}"
FAILS=0; BODY=""; CODE=""

# jget <json> <python-expr over d>  -> prints value (empty on error)
jget() { python3 -c 'import sys,json
d=json.loads(sys.argv[1])
try:
    v=eval(sys.argv[2])
    print("" if v is None else (json.dumps(v) if isinstance(v,(dict,list,bool)) else v))
except Exception:
    print("")' "$1" "$2"; }

req() { # method path [data]
  local out
  if [ -n "${3:-}" ]; then
    out=$(curl -s -m 30 -w $'\n%{http_code}' -X "$1" -H 'Content-Type: application/json' -d "$3" "$BASE_URL$2")
  else
    out=$(curl -s -m 30 -w $'\n%{http_code}' -X "$1" "$BASE_URL$2")
  fi
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
check() { # label ok(0/1)
  if [ "$2" = "1" ]; then echo "PASS  $1"; else echo "FAIL  $1  (http=$CODE body=${BODY:0:200})"; FAILS=$((FAILS+1)); fi
}
code_is() { [ "$CODE" = "$1" ] && echo 1 || echo 0; }
nonempty() { [ -n "$1" ] && echo 1 || echo 0; }

echo "Testing $BASE_URL"
req GET /api/health
check "GET /api/health 200" "$(code_is 200)"
check "health ok=true" "$([ "$(jget "$BODY" 'd["ok"]')" = "true" ] && echo 1 || echo 0)"
check "health has mode" "$(nonempty "$(jget "$BODY" 'd["mode"]')")"
MODE=$(jget "$BODY" 'd["mode"]')

req POST /api/players '{"name":"E2E Tester"}'
check "POST /api/players 2xx" "$([[ "$CODE" =~ ^20[01]$ ]] && echo 1 || echo 0)"
PID=$(jget "$BODY" 'd["player_id"]')
check "player_id returned" "$(nonempty "$PID")"

req POST /api/session/start "{\"player_id\":\"$PID\",\"sport\":\"boxing\"}"
check "POST /api/session/start 2xx" "$([[ "$CODE" =~ ^20[01]$ ]] && echo 1 || echo 0)"
SID=$(jget "$BODY" 'd["session_id"]')
check "session_id returned" "$(nonempty "$SID")"

NOW=$(python3 -c 'import datetime as D;print(D.datetime.now(D.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))')
EVENTS=$(python3 - "$SID" "$PID" "$NOW" <<'PY'
import sys, json, datetime as D
sid, pid, now = sys.argv[1:4]
t0 = D.datetime.strptime(now, "%Y-%m-%dT%H:%M:%S.000Z")
types = ["jab","cross","hook","uppercut","block"]
ev = []
for i in range(25):
    t = types[i % 5]
    blk = t == "block"
    ev.append({"session_id": sid, "player_id": pid, "sport": "boxing",
      "event_ts": (t0 + D.timedelta(milliseconds=500*i)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
      "event_type": t, "hand": "L" if i % 2 else "R",
      "speed_mps": 0 if blk else round(9 - (i % 4) * 0.7 - i * 0.03, 2),
      "accuracy": None if blk else 0.7, "reaction_ms": 250 + i,
      "guard_up": i % 3 != 0, "points": 2 if blk else 10})
print(json.dumps(ev))
PY
)
req POST /api/events "$EVENTS"
check "POST /api/events 202" "$(code_is 202)"
check "events accepted=25" "$([ "$(jget "$BODY" 'd["accepted"]')" = "25" ] && echo 1 || echo 0)"

req POST /api/events '{"not":"an array"}'
check "POST /api/events rejects bad body (4xx)" "$([[ "$CODE" =~ ^4 ]] && echo 1 || echo 0)"

sleep 1
req POST /api/session/end "{\"session_id\":\"$SID\"}"
check "POST /api/session/end 200" "$(code_is 200)"
check "end has stats.total_punches" "$(nonempty "$(jget "$BODY" 'd["stats"]["total_punches"]')")"
check "end stats.score > 0" "$([ "$(jget "$BODY" '1 if d["stats"]["score"]>0 else 0')" = "1" ] && echo 1 || echo 0)"
check "end coach has 3 tips" "$([ "$(jget "$BODY" 'len(d["coach"]["tips"])')" = "3" ] && echo 1 || echo 0)"
check "end coach has drill+badge+summary" "$(nonempty "$(jget "$BODY" 'd["coach"]["drill"] and d["coach"]["badge"] and d["coach"]["summary"]')")"
check "end has fallback flag" "$(nonempty "$(jget "$BODY" 'd["fallback"]')")"

req GET /api/leaderboard
check "GET /api/leaderboard 200" "$(code_is 200)"
check "leaderboard is list, <=10" "$([ "$(jget "$BODY" '1 if isinstance(d,list) and len(d)<=10 else 0')" = "1" ] && echo 1 || echo 0)"
check "leaderboard row has rank/name/score" "$([ "$(jget "$BODY" '1 if (len(d)==0 or all(k in d[0] for k in ("rank","player_id","name","score"))) else 0')" = "1" ] && echo 1 || echo 0)"

req GET "/api/player/$PID/stats"
check "GET /api/player/:id/stats 200" "$(code_is 200)"
check "stats player.player_id matches" "$([ "$(jget "$BODY" 'd["player"]["player_id"]')" = "$PID" ] && echo 1 || echo 0)"
check "stats has >=1 session" "$([ "$(jget "$BODY" '1 if len(d["sessions"])>=1 else 0')" = "1" ] && echo 1 || echo 0)"
check "stats has 6 percentiles" "$([ "$(jget "$BODY" 'len(d["percentiles"])')" = "6" ] && echo 1 || echo 0)"

req POST /api/ask "{\"player_id\":\"$PID\",\"question\":\"How fast are my punches?\"}"
if [ "$CODE" = "404" ]; then
  echo "SKIP  /api/ask not implemented (404)"
else
  check "POST /api/ask 200" "$(code_is 200)"
  check "ask has answer" "$(nonempty "$(jget "$BODY" 'd["answer"]')")"
fi

# --- Front-end contract (src/api/CONTRACT.md): client-generated ids, {events:[...]}, text/plain
# beacon, section-5 column names, rich /api/session/end. No /api/players or /api/session/start.
echo "--- front-end contract ---"
FE_SID=$(python3 -c 'import uuid;print(uuid.uuid4())'); FE_PID=$(python3 -c 'import uuid;print(uuid.uuid4())')
FE_EVENTS=$(python3 - "$FE_SID" "$FE_PID" "$NOW" <<'PY'
import json, sys, uuid, datetime as D
sid, pid, now = sys.argv[1:4]
t0 = D.datetime.strptime(now, "%Y-%m-%dT%H:%M:%S.000Z")
types = ["JAB", "CROSS", "HOOK", "UPPERCUT"]
ev = []
for i in range(12):
    kind = "BLOCK" if i % 6 == 5 else "PUNCH"
    ev.append({"event_id": str(uuid.uuid4()), "session_id": sid, "player_id": pid, "sport": "BOXING",
               "event_ts": (t0 + D.timedelta(milliseconds=700 * i)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
               "round_ms": 700 * i, "event_type": kind, "peak_velocity": 15 + i, "reaction_ms": 280 + i,
               "accuracy_score": 70 + i, "symmetry_ratio": None,
               "metrics": {"punchType": types[i % 4], "hand": "L" if i % 2 else "R", "landed": i % 4 != 3}})
ev.append({**ev[0], "event_id": str(uuid.uuid4()), "event_type": "TICK", "metrics": {}})
print(json.dumps({"events": ev}))
PY
)
req POST /api/events "$FE_EVENTS"
check "FE POST /api/events {events:[...]} 2xx" "$([[ "$CODE" =~ ^20[024]$ ]] && echo 1 || echo 0)"
check "FE events accepted=12 ignored=1" "$([ "$(jget "$BODY" '"%s/%s" % (d["accepted"], d["ignored"])')" = "12/1" ] && echo 1 || echo 0)"
out=$(curl -s -m 30 -w $'\n%{http_code}' -X POST -H 'Content-Type: text/plain;charset=UTF-8' -d "$FE_EVENTS" "$BASE_URL/api/events")
CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
check "FE text/plain beacon resend is deduped" "$([ "$(jget "$BODY" 'd["duplicates"]')" = "12" ] && echo 1 || echo 0)"
req POST /api/session/end "{\"session_id\":\"$FE_SID\",\"player_id\":\"$FE_PID\",\"display_name\":\"Smoke FE\",\"sport\":\"BOXING\",\"started_at\":\"$NOW\",\"ended_at\":\"$NOW\",\"final_score\":900,\"result\":\"WIN\",\"avg_inference_fps\":29.5,\"stats\":{\"punches\":10}}"
check "FE POST /api/session/end 200" "$(code_is 200)"
check "FE coach headline + 3 tips" "$([ "$(jget "$BODY" '1 if d["coach"]["headline"] and len(d["coach"]["tips"])==3 else 0')" = "1" ] && echo 1 || echo 0)"
check "FE coach drill/badge are {name,description}" "$([ "$(jget "$BODY" '1 if all(d["coach"][k]["name"] and d["coach"][k]["description"] for k in ("drill","badge")) else 0')" = "1" ] && echo 1 || echo 0)"
check "FE leaderboard rows have display_name/sport/score" "$([ "$(jget "$BODY" '1 if isinstance(d["leaderboard"],list) and all(k in r for r in d["leaderboard"] for k in ("rank","player_id","display_name","sport","score")) else 0')" = "1" ] && echo 1 || echo 0)"
check "FE form_score present" "$([ "$(jget "$BODY" '1 if "form_score" in d else 0')" = "1" ] && echo 1 || echo 0)"
check "FE coach has grounding/structured/focus (or is warming up)" "$([ "$(jget "$BODY" '1 if d.get("warming_up") or (d["coach"]["grounding"]["source"] in ("cortex_search","mock","fallback") and isinstance(d["coach"]["structured"], bool) and "focus" in d["coach"]) else 0')" = "1" ] && echo 1 || echo 0)"
req GET "/api/player/$FE_PID/stats"
check "FE player created with display_name" "$([ "$(jget "$BODY" 'd["player"]["name"]')" = "Smoke FE" ] && echo 1 || echo 0)"

# --- Multi-sport (sql/PLUS_CONTRACT.md "Multi-sport"): goalkeeper SAVE/GOAL as the game sends them.
echo "--- goalkeeper ---"
GK_SID=$(python3 -c 'import uuid;print(uuid.uuid4())'); GK_PID=$(python3 -c 'import uuid;print(uuid.uuid4())')
GK_EVENTS=$(python3 - "$GK_SID" "$GK_PID" "$NOW" <<'PY2'
import json, sys, uuid, datetime as D
sid, pid, now = sys.argv[1:4]
t0 = D.datetime.strptime(now, "%Y-%m-%dT%H:%M:%S.000Z")
ev = []
for i, (kind, zone) in enumerate([("SAVE", 0), ("GOAL", 2), ("SAVE", 4)]):
    ev.append({"event_id": str(uuid.uuid4()), "session_id": sid, "player_id": pid, "sport": "GOALKEEPER",
               "event_ts": (t0 + D.timedelta(seconds=9 * i)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
               "round_ms": 9000 * i, "event_type": kind, "peak_velocity": 9.5, "reaction_ms": 320 + i,
               "accuracy_score": 70, "symmetry_ratio": 0.5,
               "metrics": {"kick": i, "zone": zone, "row": zone // 3, "col": zone % 3,
                           "part": "left" if kind == "SAVE" else None, "punch": False, "source": "mouse"}})
print(json.dumps({"events": ev}))
PY2
)
req POST /api/events "$GK_EVENTS"
check "GK POST /api/events SAVE/GOAL accepted=3" "$([ "$(jget "$BODY" 'd["accepted"]')" = "3" ] && echo 1 || echo 0)"
req POST /api/session/end "{\"session_id\":\"$GK_SID\",\"player_id\":\"$GK_PID\",\"display_name\":\"Smoke Keeper\",\"sport\":\"GOALKEEPER\",\"started_at\":\"$NOW\",\"ended_at\":\"$NOW\",\"final_score\":2570,\"result\":\"WIN\",\"avg_inference_fps\":null,\"stats\":{}}"
check "GK POST /api/session/end 200 + 3 tips" "$([ "$CODE" = "200" ] && [ "$(jget "$BODY" 'len(d["coach"]["tips"])')" = "3" ] && echo 1 || echo 0)"
check "GK session score = 2 saves (2570)" "$([ "$(jget "$BODY" 'd["stats"]["score"]')" = "2570" ] && echo 1 || echo 0)"
check "GK end leaderboard is the goalkeeper board" "$([ "$(jget "$BODY" '1 if d["leaderboard"] and all(r["sport"]=="GOALKEEPER" for r in d["leaderboard"]) else 0')" = "1" ] && echo 1 || echo 0)"
req GET "/api/leaderboard?sport=goalkeeper"
check "GET /api/leaderboard?sport=goalkeeper has the keeper" "$([ "$CODE" = "200" ] && [ "$(jget "$BODY" '1 if any(r["player_id"]=="'"$GK_PID"'" and r["sport"]=="GOALKEEPER" for r in d) else 0')" = "1" ] && echo 1 || echo 0)"
req GET /api/leaderboard
check "boxing leaderboard has no goalkeeper rows" "$([ "$(jget "$BODY" '1 if all(r["player_id"]!="'"$GK_PID"'" for r in d) else 0')" = "1" ] && echo 1 || echo 0)"
req GET "/api/leaderboard?sport=tennis"
check "leaderboard rejects unknown sport (400)" "$(code_is 400)"

# --- Snowflake Plus (sql/PLUS_CONTRACT.md "New server endpoints"). In real mode a missing object
# answers 200 with available:false, so data checks only apply when available is true.
echo "--- snowflake plus ---"
req GET "/api/player/$PID/style"
check "GET /api/player/:id/style 200" "$(code_is 200)"
check "style has available + player_id" "$([ "$(jget "$BODY" '1 if isinstance(d["available"], bool) and d["player_id"] else 0')" = "1" ] && echo 1 || echo 0)"
check "style components are 6 values in 0..100 (or unavailable)" "$([ "$(jget "$BODY" '1 if (not d["available"] or d["components"] is None or (list(d["components"])==["speed","reaction","accuracy","guard","symmetry","endurance"] and all(0<=v<=100 for v in d["components"].values()))) else 0')" = "1" ] && echo 1 || echo 0)"
check "style has twin + scouting keys" "$([ "$(jget "$BODY" '1 if all(k in d for k in ("pro_similarity_pct","twin","scouting")) else 0')" = "1" ] && echo 1 || echo 0)"
req GET "/api/player/nobody-$SID/style"
check "style unknown player 404" "$(code_is 404)"

req GET "/api/player/$PID/progress"
check "GET /api/player/:id/progress 200" "$(code_is 200)"
check "progress shape" "$([ "$(jget "$BODY" '1 if isinstance(d["history"], list) and isinstance(d["improving"], bool) and all(k in d for k in ("sessions","best_score","last_score","speed_trend_mps_per_session","score_trend_per_session","accuracy_trend_pct_per_session","reaction_trend_ms_per_session")) else 0')" = "1" ] && echo 1 || echo 0)"
if [ "$MODE" = "mock" ]; then
  check "progress has >=1 session in history (mock)" "$([ "$(jget "$BODY" '1 if d["available"] and d["sessions"]>=1 and len(d["history"])>=1 else 0')" = "1" ] && echo 1 || echo 0)"
fi

req GET "/api/highlights?limit=5"
check "GET /api/highlights 200" "$(code_is 200)"
check "highlights list <= 5 with contract keys" "$([ "$(jget "$BODY" '1 if isinstance(d["available"], bool) and len(d["highlights"])<=5 and all(set(h)=={"highlight_id","created_at","kind","player_id","name","session_id","value","unit","message"} for h in d["highlights"]) else 0')" = "1" ] && echo 1 || echo 0)"
if [ "$MODE" = "mock" ]; then
  check "highlights non-empty (mock)" "$([ "$(jget "$BODY" '1 if d["available"] and len(d["highlights"])>0 else 0')" = "1" ] && echo 1 || echo 0)"
fi
req GET "/api/highlights?limit=0"
check "highlights rejects limit=0 (400)" "$(code_is 400)"

req GET "/api/drills/search?q=keep%20my%20guard%20up&focus=guard"
check "GET /api/drills/search 200" "$(code_is 200)"
check "drills: source + results all focus=guard" "$([ "$(jget "$BODY" '1 if d["source"] in ("cortex_search","mock") and all(r["focus"]=="guard" for r in d["results"]) and (not d["available"] or len(d["results"])>0) else 0')" = "1" ] && echo 1 || echo 0)"
req GET "/api/drills/search?focus=kicking"
check "drills rejects unknown focus (400)" "$(code_is 400)"

req GET /api/snowflake/status
check "GET /api/snowflake/status 200" "$(code_is 200)"
check "status lists 7 features with a status each" "$([ "$(jget "$BODY" '1 if sorted(d["features"])==["cortex_analyst","cortex_complete","cortex_search","dynamic_tables","streams_tasks","structured_output","vectors"] and all("status" in v for v in d["features"].values()) else 0')" = "1" ] && echo 1 || echo 0)"
check "status mode matches health" "$([ "$(jget "$BODY" 'd["mode"]')" = "$MODE" ] && echo 1 || echo 0)"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; exit 1; fi
