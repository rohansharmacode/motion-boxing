# Kinetic Ring: How we used Snowflake

```
Browser game -> Express API -> MOTION_EVENTS / PLAYERS / SESSIONS
  -> Dynamic Tables (PLAYER_FORM, SESSION_SUMMARY, PLAYER_PROGRESS)
  -> Streams + Tasks (T_HIGHLIGHTS, T_SCOUTING)
  -> Cortex AI (AI_COMPLETE, AI_CLASSIFY, AI_AGG, Search, Analyst)
  -> Back to game: coach card, highlights ticker, leaderboards
```


Every move you make becomes data. The browser batches each punch, save, arrow or roll (type, hand, speed, reaction time, accuracy) to our Express API, which writes them to `MOTION_EVENTS`, with `PLAYERS` and `SESSIONS` alongside.

Inside Snowflake:
- **Dynamic Tables** (`PLAYER_FORM`, `SESSION_SUMMARY` -> `PLAYER_PROGRESS`) roll raw events into form and improvement trends (`REGR_SLOPE`).
- **Streams + Tasks**: `T_HIGHLIGHTS` writes a live highlights feed (speed records, personal bests, milestones) and flags impossible punch speeds as anti-cheat. `T_SCOUTING` uses `AI_CLASSIFY` and `AI_COMPLETE` to label your fighting style and write a scouting report.
- **Cortex `AI_COMPLETE` with a JSON schema** writes the post-round coach card (headline, 3 tips, drill, badge), grounded by **Cortex Search** over a drill library (RAG).
- **VECTOR similarity** finds your "style twin"; **Cortex Analyst**, guarded text-to-SQL, **Time Travel** and `AI_AGG` power a **Streamlit in Snowflake** coaching dashboard.
- Least-privilege roles, X-Small warehouse with auto-suspend, and tasks that skip when no one is playing.

In the game you see it as the coach card after each round, the home-screen highlights ticker, per-sport leaderboards and stats.

Honest status: all of this ran end-to-end on a real Snowflake account during the hackathon (real Cortex coach cards; screenshots in `docs/snowflake-screens/`). The public Render demo runs the server in **mock mode** (same API, in-memory data), so the live site does not spend Snowflake credits; the highlights ticker there is labelled "MOCK".

