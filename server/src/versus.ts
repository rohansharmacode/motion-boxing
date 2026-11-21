// Online 1v1 relay: two browsers meet in a room by a 4-letter code, then every game message is
// forwarded to the other seat unchanged. The server keeps no game state; each browser is
// authoritative over its own health, so the relay stays tiny and adds only one network hop.
//
// Client -> server: { t: 'create', name } | { t: 'join', room, name } | { t: 'msg', d } | { t: 'ping', at }
// Server -> client: { t: 'joined', room, seat, peer } | { t: 'peer-joined', name } | { t: 'peer-left' }
//                   { t: 'msg', d } | { t: 'pong', at } | { t: 'error', reason }
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Logger } from './logger';

export const VERSUS_PATH = '/versus';
/** No 0/O or 1/I, so a code read across a table is never ambiguous. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;
const MAX_MESSAGE_BYTES = 4096;
const MAX_ROOMS = 500;
const NAME_MAX = 24;
const HEARTBEAT_MS = 15_000;

interface Seat {
  ws: WebSocket;
  name: string;
  alive: boolean;
}

interface Room {
  code: string;
  seats: [Seat | null, Seat | null];
}

export interface VersusRelay {
  /** Rooms currently open (for tests and logs). */
  readonly roomCount: number;
  close(): void;
}

function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_MAX) : '';
  return s || 'Player';
}

function newCode(rooms: Map<string, Room>): string {
  for (let i = 0; i < 50; i++) {
    let code = '';
    for (let j = 0; j < CODE_LEN; j++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('no free room code');
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Attach the relay to an existing HTTP server. Upgrades on any other path are left alone. */
export function attachVersusRelay(server: Server, log: Logger): VersusRelay {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const rooms = new Map<string, Room>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== VERSUS_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws: WebSocket) => {
    let room: Room | null = null;
    let seatIndex: 0 | 1 = 0;
    const seat: Seat = { ws, name: 'Player', alive: true };

    const other = (): Seat | null => (room ? room.seats[seatIndex === 0 ? 1 : 0] : null);

    const leave = (): void => {
      if (!room) return;
      const r = room;
      room = null;
      r.seats[seatIndex] = null;
      const peer = r.seats[seatIndex === 0 ? 1 : 0];
      if (peer) send(peer.ws, { t: 'peer-left' });
      if (!r.seats[0] && !r.seats[1]) rooms.delete(r.code);
    };

    ws.on('pong', () => {
      seat.alive = true;
    });

    ws.on('message', (raw: RawData) => {
      let msg: { t?: unknown; room?: unknown; name?: unknown; d?: unknown; at?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;

      if (msg.t === 'msg') {
        const peer = other();
        if (peer) send(peer.ws, { t: 'msg', d: msg.d });
        return;
      }
      if (msg.t === 'ping') {
        send(ws, { t: 'pong', at: msg.at });
        return;
      }
      if (msg.t === 'create' || msg.t === 'join') {
        if (room) leave();
        seat.name = cleanName(msg.name);
        if (msg.t === 'create') {
          if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', reason: 'busy' });
          const code = newCode(rooms);
          room = { code, seats: [seat, null] };
          seatIndex = 0;
          rooms.set(code, room);
          send(ws, { t: 'joined', room: code, seat: 0, peer: null });
          log.info('versus: room created', { room: code });
          return;
        }
        const code = typeof msg.room === 'string' ? msg.room.trim().toUpperCase() : '';
        const target = rooms.get(code);
        if (!target) return send(ws, { t: 'error', reason: 'not-found' });
        const free = target.seats[0] === null ? 0 : target.seats[1] === null ? 1 : null;
        if (free === null) return send(ws, { t: 'error', reason: 'full' });
        room = target;
        seatIndex = free;
        target.seats[free] = seat;
        const peer = other();
        send(ws, { t: 'joined', room: code, seat: free, peer: peer ? peer.name : null });
        if (peer) send(peer.ws, { t: 'peer-joined', name: seat.name });
        log.info('versus: player joined', { room: code });
      }
    });

    ws.on('close', leave);
    ws.on('error', leave);
  });

  // Drop sockets that stop answering pings (laptop lid closed, Wi-Fi gone) so the peer hears peer-left.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const s = [...rooms.values()].flatMap((r) => r.seats).find((x) => x?.ws === ws);
      if (s && !s.alive) {
        ws.terminate();
        continue;
      }
      if (s) s.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    get roomCount() {
      return rooms.size;
    },
    close() {
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      rooms.clear();
    },
  };
}
