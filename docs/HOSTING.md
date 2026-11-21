# Hosting online

One Render web service hosts the game, the API and the 1v1 relay on one HTTPS origin
(HTTPS is needed for the webcam). Config: `render.yaml` at the repo root.

1. Open https://render.com/deploy?repo=https://github.com/rohansharmacode/motion-boxing
2. Sign in with GitHub, allow Render to read `motion-boxing`, click **Apply**.
3. The game is at `https://motion-boxing.onrender.com` (or the name Render shows).

How it works: the build sets `VITE_API_URL=same-origin`, so the page calls `/api` on its own host,
and the 1v1 lobby defaults to `wss://<host>/versus`. The server serves `dist/` when `STATIC_DIR` is set.
Snowflake runs in mock mode. For real Snowflake, add the `SNOWFLAKE_*` vars from
`server/.env.example` as secrets in the Render dashboard and set `SNOWFLAKE_MOCK=0`. Never commit keys.

Free plan note: the service sleeps after 15 minutes idle and takes about 50 s to wake.
Open the URL a minute before a demo.
