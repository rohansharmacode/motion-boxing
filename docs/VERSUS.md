# Online 1v1 (two laptops)

Each laptop runs the game with its own webcam. A tiny WebSocket relay on the Express server pairs them by a 4-letter room code and forwards messages. No game state lives on the server.

## Run it

1. **Host laptop** (one of the two, or a third): `npm run server:mock` (or `npm run server` with Snowflake). The relay listens on `ws://<host-ip>:3001/versus`. Find the IP with `ipconfig` (Windows) or `ipconfig getifaddr en0` (macOS).
2. **Both laptops**: `npm run dev` and open `http://localhost:5173` there. The webcam only works on `localhost` or HTTPS, so each laptop serves its own copy.
3. Boxing, then **Play a friend online**. Open **Server** and type the host address, for example `192.168.1.20:3001` (saved for next time). Or start the page with `?relay=192.168.1.20:3001`.
4. Laptop A: **Create a room**, read out the code. Laptop B: type the code, **Join**. `?room=ABCD` joins straight away.
5. Both pick **Use camera** (or **Keyboard**). The round starts when both are calibrated.

## First time on a laptop

```
git clone https://github.com/rohansharmacode/motion-boxing
cd motion-boxing
npm install
npm run dev
```

If `git pull` says "not a git repository", the folder is not a clone: run the clone above instead. The repo is private, so each teammate's GitHub account needs access.

## Windows

- All `npm run` scripts work in PowerShell and cmd (no bash needed). `npm run server:mock` installs the server's packages on first run.
- When Windows asks whether Node.js may use the network, allow **Private networks**, or the other laptop cannot reach port 3001. If it was dismissed: Windows Security, Firewall & network protection, Allow an app through firewall, Node.js, tick Private.
- The host IP is the `IPv4 Address` line of `ipconfig` for the Wi-Fi adapter.
- Windows may mark a hotspot or venue Wi-Fi as Public, which blocks incoming connections. Settings, Network & internet, Wi-Fi, the network, set it to **Private**.

Venue Wi-Fi often blocks laptop-to-laptop traffic. If "Could not reach the game server" shows, put both laptops on one phone hotspot.

## How a punch works

- Your punch lands on the opponent figure on your screen and is sent to the other laptop (one punch in flight at a time, so spamming does nothing).
- Their screen telegraphs it for 1 s: straights (jab, cross) can be slipped or ducked, hooks ducked, uppercuts slipped. Guard cuts damage by 80 percent.
- Their laptop decides blocked, dodged or hit, takes the damage and sends back its health. Each laptop owns its own health, so the two screens never disagree.
- Health 0 is a KO for both screens. At the bell, more health wins.

## Code

- `server/src/versus.ts`: room relay (create, join, forward, ping, peer-left). Tests: `server/test/versus.test.ts`.
- `src/sports/boxing/versus/client.ts`: WebSocket client and relay address.
- `src/sports/boxing/versus/index.ts` + `lobby.css`: lobby card and the ready/start handshake.
- `src/sports/boxing/engine.ts`: `setVersus`, `incomingPunch`, `punchResolved`. With a link set the drone AI is off. Tests: `tests/unit/versus-engine.test.ts`.
