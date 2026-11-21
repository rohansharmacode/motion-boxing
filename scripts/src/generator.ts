// Deterministic generator of realistic boxing sessions. Pure: no IO.
export type EventType = 'jab' | 'cross' | 'hook' | 'uppercut' | 'block';
export const PUNCH_TYPES: EventType[] = ['jab', 'cross', 'hook', 'uppercut'];
export const SEED_TAG = ' [seed]'; // appended to player names so --reset can find them

export interface GenEvent {
  event_ts: string; // ISO
  event_type: EventType;
  hand: 'L' | 'R';
  speed_mps: number;
  accuracy: number | null;
  reaction_ms: number | null;
  guard_up: boolean;
  points: number;
}
export interface SessionStats {
  score: number;
  total_punches: number; // punches only, blocks excluded
  avg_speed: number;
  max_speed: number;
  avg_reaction_ms: number | null;
  best_reaction_ms: number | null;
  accuracy: number; // mean 0..1 over punches
}
export interface GenSession {
  player_id: string;
  session_id: string;
  started_at: string;
  ended_at: string;
  events: GenEvent[];
  stats: SessionStats;
}
export interface GenPlayer {
  player_id: string;
  name: string;
  leftDominant: boolean;
  lowGuard: boolean;
  skill: number;
  fatigue: number;
  improving: boolean;
}
export interface GenResult { seed: number; players: GenPlayer[]; sessions: GenSession[] }
export interface GenOptions { seed?: number; players?: number; sessionsPerPlayer?: number; baseTime?: string }

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Mia', 'Leo', 'Zara', 'Omar', 'Ines', 'Kai', 'Nora', 'Dev', 'Ava', 'Rui', 'Tess', 'Jon', 'Lila', 'Max', 'Yuki', 'Sam', 'Ana', 'Ravi', 'Elle', 'Theo', 'Priya', 'Gus', 'Noor', 'Finn'];
const LAST = ['Stone', 'Reyes', 'Khan', 'Nakamura', 'Okafor', 'Silva', 'Novak', 'Patel', 'Brooks', 'Duarte', 'Haas', 'Lindqvist', 'Moreau', 'Tan', 'Ito', 'Cruz'];

const BASE_SPEED: Record<string, number> = { jab: 9.2, cross: 9.0, hook: 7.4, uppercut: 6.8 };
const BASE_POINTS: Record<string, number> = { jab: 10, cross: 15, hook: 20, uppercut: 25 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

export function generate(opts: GenOptions = {}): GenResult {
  const seed = opts.seed ?? 42;
  const nPlayers = opts.players ?? 20;
  const nSessions = opts.sessionsPerPlayer ?? 3;
  const base = Date.parse(opts.baseTime ?? '2026-01-05T10:00:00.000Z');
  const rnd = mulberry32(seed);
  const uni = (lo: number, hi: number) => lo + (hi - lo) * rnd();
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const uuid = () => {
    const h = () => Math.floor(rnd() * 0x100000000).toString(16).padStart(8, '0');
    const s = h() + h() + h() + h();
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
  };

  const players: GenPlayer[] = [];
  const sessions: GenSession[] = [];
  const used = new Set<string>();

  for (let p = 0; p < nPlayers; p++) {
    let name: string;
    do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (used.has(name));
    used.add(name);
    const player: GenPlayer = {
      player_id: uuid(),
      name: name + SEED_TAG,
      leftDominant: rnd() < 0.3,
      lowGuard: rnd() < 0.3,
      skill: uni(0.3, 0.95),
      fatigue: uni(0.05, 0.15),
      improving: p % 5 === 2, // a few players improve across sessions
    };
    players.push(player);

    const power = uni(0.85, 1.15);
    const reactBase = uni(180, 450);
    const guardBase = player.lowGuard ? uni(0.3, 0.55) : uni(0.65, 0.95);
    const blockShare = uni(0.08, 0.22);
    const mix = { jab: uni(0.3, 0.45), cross: uni(0.2, 0.3), hook: uni(0.1, 0.25), uppercut: uni(0.05, 0.15) };
    const mixSum = mix.jab + mix.cross + mix.hook + mix.uppercut;

    for (let s = 0; s < nSessions; s++) {
      const dur = uni(60, 120); // seconds
      const n = Math.round(uni(80, 200));
      const start = base + p * 3600_000 + s * 86400_000 + Math.floor(rnd() * 1800_000);
      const imp = player.improving ? s : 0;
      const sessionPower = power * (1 + 0.04 * imp);
      const drop = clamp(player.fatigue * (player.improving ? 1 - 0.3 * s : 1), 0.02, 0.2);
      const slope = drop / 0.75; // so Q1 vs Q4 average gap ~= drop
      const sessionSkill = clamp(player.skill + 0.03 * imp, 0.3, 0.95);

      // ascending timestamps: random gaps normalised to the duration
      const gaps = Array.from({ length: n }, () => -Math.log(1 - rnd()) + 0.15);
      const gsum = gaps.reduce((a, b) => a + b, 0);
      let tms = 0;
      let prevMs = -1;
      const events: GenEvent[] = [];
      for (let i = 0; i < n; i++) {
        tms += (gaps[i] / gsum) * dur * 1000;
        const ms = Math.max(Math.round(tms), prevMs + 1);
        prevMs = ms;
        const progress = ms / (dur * 1000);
        const fat = slope * progress;

        let type: EventType;
        if (rnd() < blockShare) type = 'block';
        else {
          let x = rnd() * mixSum;
          type = 'uppercut';
          for (const t of PUNCH_TYPES) { x -= mix[t as keyof typeof mix]; if (x <= 0) { type = t; break; } }
        }
        // jab/uppercut lead hand bias, hook/cross rear hand bias
        const domP = player.leftDominant ? 0.35 : 0.65; // P(R)
        const hand: 'L' | 'R' = rnd() < domP ? 'R' : 'L';
        const dominant = hand === (player.leftDominant ? 'L' : 'R');
        const guard_up = rnd() < clamp(guardBase - fat * 0.5, 0.05, 0.98);
        const reaction_ms = rnd() < 0.65 ? r2(clamp(reactBase * (1 + fat * 0.5 - 0.03 * imp) + gauss() * 30, 150, 650)) : null;

        if (type === 'block') {
          events.push({ event_ts: new Date(start + ms).toISOString(), event_type: type, hand, speed_mps: 0, accuracy: null, reaction_ms, guard_up: true, points: 2 });
          continue;
        }
        const speed = BASE_SPEED[type] * sessionPower * (dominant ? 1 : 0.93) * (1 - fat) * (1 + gauss() * 0.06);
        const accuracy = clamp(sessionSkill - fat * 0.3 + gauss() * 0.12, 0.05, 1);
        events.push({
          event_ts: new Date(start + ms).toISOString(),
          event_type: type,
          hand,
          speed_mps: r2(clamp(speed, 4, 12)),
          accuracy: r2(accuracy),
          reaction_ms,
          guard_up,
          points: Math.max(1, Math.round(BASE_POINTS[type] * accuracy)),
        });
      }
      sessions.push({
        player_id: player.player_id,
        session_id: uuid(),
        started_at: new Date(start).toISOString(),
        ended_at: new Date(start + Math.round(dur * 1000) + 2000).toISOString(),
        events,
        stats: computeStats(events),
      });
    }
  }
  return { seed, players, sessions };
}

export function computeStats(events: GenEvent[]): SessionStats {
  const punches = events.filter((e) => e.event_type !== 'block');
  const rx = events.map((e) => e.reaction_ms).filter((v): v is number => v != null);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    score: events.reduce((a, e) => a + e.points, 0),
    total_punches: punches.length,
    avg_speed: r2(mean(punches.map((e) => e.speed_mps))),
    max_speed: Math.max(0, ...punches.map((e) => e.speed_mps)),
    avg_reaction_ms: rx.length ? r2(mean(rx)) : null,
    best_reaction_ms: rx.length ? Math.min(...rx) : null,
    accuracy: r2(mean(punches.map((e) => e.accuracy ?? 0))),
  };
}

/** Avg punch speed by event-count quartile; returns [Q1..Q4]. */
export function quartileSpeeds(events: GenEvent[]): number[] {
  const punches = events;
  const q = Math.ceil(punches.length / 4);
  return [0, 1, 2, 3].map((i) => {
    const sl = punches.slice(i * q, (i + 1) * q).filter((e) => e.event_type !== 'block');
    return sl.reduce((a, e) => a + e.speed_mps, 0) / Math.max(1, sl.length);
  });
}
