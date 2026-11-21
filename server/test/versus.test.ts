import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { silentLogger } from '../src/logger';
import { attachVersusRelay, type VersusRelay } from '../src/versus';

let server: http.Server;
let relay: VersusRelay;
let url: string;
const open: WebSocket[] = [];

beforeEach(async () => {
  server = http.createServer();
  relay = attachVersusRelay(server, silentLogger);
  await new Promise<void>((r) => server.listen(0, r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/versus`;
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  relay.close();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Connected socket with a queue of parsed messages. */
async function client(): Promise<{ ws: WebSocket; next: () => Promise<any>; send: (m: unknown) => void }> {
  const ws = new WebSocket(url);
  open.push(ws);
  const queue: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  await new Promise((r) => ws.once('open', r));
  return {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
  };
}

describe('versus relay', () => {
  it('pairs two players by room code and forwards messages both ways', async () => {
    const a = await client();
    a.send({ t: 'create', name: 'Rohan' });
    const created = await a.next();
    expect(created).toMatchObject({ t: 'joined', seat: 0, peer: null });
    expect(created.room).toMatch(/^[A-Z2-9]{4}$/);

    const b = await client();
    b.send({ t: 'join', room: created.room.toLowerCase(), name: 'Sankar' });
    expect(await b.next()).toMatchObject({ t: 'joined', seat: 1, peer: 'Rohan' });
    expect(await a.next()).toEqual({ t: 'peer-joined', name: 'Sankar' });

    a.send({ t: 'msg', d: { k: 'punch', id: 1, kind: 'jab' } });
    expect(await b.next()).toEqual({ t: 'msg', d: { k: 'punch', id: 1, kind: 'jab' } });
    b.send({ t: 'msg', d: { k: 'hp', hp: 90 } });
    expect(await a.next()).toEqual({ t: 'msg', d: { k: 'hp', hp: 90 } });
  });

  it('rejects unknown and full rooms', async () => {
    const a = await client();
    a.send({ t: 'join', room: 'ZZZZ' });
    expect(await a.next()).toEqual({ t: 'error', reason: 'not-found' });

    a.send({ t: 'create' });
    const { room } = await a.next();
    const b = await client();
    b.send({ t: 'join', room });
    await b.next();
    const c = await client();
    c.send({ t: 'join', room });
    expect(await c.next()).toEqual({ t: 'error', reason: 'full' });
  });

  it('tells the other player when someone leaves and frees the room', async () => {
    const a = await client();
    a.send({ t: 'create' });
    const { room } = await a.next();
    const b = await client();
    b.send({ t: 'join', room });
    await b.next();
    await a.next();
    b.ws.close();
    expect(await a.next()).toEqual({ t: 'peer-left' });
    a.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(relay.roomCount).toBe(0);
  });

  it('answers ping with pong for latency display', async () => {
    const a = await client();
    a.send({ t: 'ping', at: 123 });
    expect(await a.next()).toEqual({ t: 'pong', at: 123 });
  });
});
