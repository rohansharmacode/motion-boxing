import { randomUUID } from 'node:crypto';
import { aggregatePlayer, aggregateSession, isPunch } from '../metrics';
import type {
  Benchmark,
  LeaderboardRow,
  MotionEvent,
  Player,
  PlayerMetrics,
  SessionAggregate,
  SessionRecord,
  SessionStats,
  SessionSummary,
  StoredCoach,
} from '../types';
import { round } from '../util';
import type { Repo } from './types';

/** Same values as the PRO_BENCHMARKS seed in sql/setup.sql. */
export const DEFAULT_BENCHMARKS: Benchmark[] = [
  { sport: 'boxing', metric: 'punch_speed_mps', p25: 5.5, p50: 7.0, p75: 8.5, p90: 10.0, pro_avg: 9.5, higher_is_better: true },
  { sport: 'boxing', metric: 'reaction_ms', p25: 210, p50: 250, p75: 300, p90: 360, pro_avg: 190, higher_is_better: false },
  { sport: 'boxing', metric: 'accuracy_pct', p25: 55, p50: 65, p75: 75, p90: 83, pro_avg: 85, higher_is_better: true },
  { sport: 'boxing', metric: 'guard_pct', p25: 50, p50: 65, p75: 78, p90: 88, pro_avg: 92, higher_is_better: true },
  { sport: 'boxing', metric: 'symmetry_pct', p25: 70, p50: 80, p75: 88, p90: 93, pro_avg: 92, higher_is_better: true },
  { sport: 'boxing', metric: 'fatigue_drop_pct', p25: 3, p50: 8, p75: 14, p90: 20, pro_avg: 4, higher_is_better: false },
];

interface StoredSession {
  session_id: string;
  player_id: string;
  sport: string;
  started_at: string;
  ended_at: string | null;
  stats: SessionStats | null;
  coach: StoredCoach | null;
}

/** In-memory repository for SNOWFLAKE_MOCK=1 and tests. */
export class MemoryRepo implements Repo {
  readonly mode = 'mock' as const;
  readonly players = new Map<string, Player & { created_at: string }>();
  readonly sessions = new Map<string, StoredSession>();
  readonly events: MotionEvent[] = [];
  private readonly eventIds = new Set<string>();
  benchmarkRows: Benchmark[] = DEFAULT_BENCHMARKS.map((b) => ({ ...b }));

  async ping(): Promise<boolean> {
    return true;
  }

  async createPlayer(name: string): Promise<string> {
    const player_id = randomUUID();
    this.players.set(player_id, { player_id, name, created_at: new Date().toISOString() });
    return player_id;
  }

  async getPlayer(playerId: string): Promise<Player | null> {
    const p = this.players.get(playerId);
    return p ? { player_id: p.player_id, name: p.name } : null;
  }

  async createSession(playerId: string, sport: string): Promise<string> {
    const session_id = randomUUID();
    this.sessions.set(session_id, {
      session_id,
      player_id: playerId,
      sport,
      started_at: new Date().toISOString(),
      ended_at: null,
      stats: null,
      coach: null,
    });
    return session_id;
  }

  async ensurePlayer(playerId: string, name: string | null): Promise<void> {
    const p = this.players.get(playerId);
    if (p) {
      if (name) p.name = name;
      return;
    }
    this.players.set(playerId, { player_id: playerId, name: name || 'Player', created_at: new Date().toISOString() });
  }

  async ensureSession(sessionId: string, playerId: string, sport: string, startedAt: string | null): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, {
      session_id: sessionId,
      player_id: playerId,
      sport,
      started_at: startedAt ? new Date(startedAt).toISOString() : new Date().toISOString(),
      ended_at: null,
      stats: null,
      coach: null,
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(sessionId);
    return s ? structuredClone(s) : null;
  }

  async insertEvents(events: MotionEvent[], opts: { dedupe?: boolean } = {}): Promise<void> {
    for (const e of events) {
      if (opts.dedupe && this.eventIds.has(e.event_id)) continue;
      this.eventIds.add(e.event_id);
      this.events.push({ ...e });
    }
  }

  async aggregateSession(sessionId: string): Promise<SessionAggregate> {
    return aggregateSession(this.events.filter((e) => e.session_id === sessionId));
  }

  async finalizeSession(sessionId: string, stats: SessionStats, coach: StoredCoach): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s || s.coach) return false;
    s.ended_at = s.ended_at ?? new Date().toISOString();
    s.stats = { ...stats };
    s.coach = structuredClone(coach);
    return true;
  }

  /** Mirrors V_LEADERBOARD: best single-session score per player, top N. */
  async leaderboard(limit: number): Promise<LeaderboardRow[]> {
    const perSession = new Map<string, { player_id: string; score: number }>();
    const perPlayer = new Map<string, { fastest: number | null; bestRt: number | null }>();
    for (const e of this.events) {
      if (String(e.sport ?? 'boxing').toLowerCase() !== 'boxing') continue;
      const s = perSession.get(e.session_id) ?? { player_id: e.player_id, score: 0 };
      s.score += e.points ?? 0;
      perSession.set(e.session_id, s);
      const p = perPlayer.get(e.player_id) ?? { fastest: null, bestRt: null };
      if (isPunch(e)) p.fastest = p.fastest === null ? e.speed_mps : Math.max(p.fastest, e.speed_mps);
      if (typeof e.reaction_ms === 'number' && e.reaction_ms > 0) {
        p.bestRt = p.bestRt === null ? e.reaction_ms : Math.min(p.bestRt, e.reaction_ms);
      }
      perPlayer.set(e.player_id, p);
    }
    const best = new Map<string, number>();
    for (const s of perSession.values()) best.set(s.player_id, Math.max(best.get(s.player_id) ?? -Infinity, s.score));

    const rows = [...best.entries()].map(([player_id, score]) => ({
      player_id,
      name: this.players.get(player_id)?.name ?? 'Unknown',
      score,
      fastest_punch: round(perPlayer.get(player_id)?.fastest ?? null, 2),
      best_reaction_ms: round(perPlayer.get(player_id)?.bestRt ?? null, 1),
    }));
    const desc = (a: number | null, b: number | null) => (b ?? -Infinity) - (a ?? -Infinity);
    const asc = (a: number | null, b: number | null) => (a ?? Infinity) - (b ?? Infinity);
    rows.sort(
      (a, b) =>
        desc(a.score, b.score) ||
        desc(a.fastest_punch, b.fastest_punch) ||
        asc(a.best_reaction_ms, b.best_reaction_ms) ||
        (a.player_id < b.player_id ? -1 : 1),
    );
    return rows.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
  }

  async playerSessions(playerId: string, limit: number): Promise<SessionSummary[]> {
    return [...this.sessions.values()]
      .filter((s) => s.player_id === playerId)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, limit)
      .map((s) => ({
        session_id: s.session_id,
        started_at: s.started_at,
        ended_at: s.ended_at,
        score: s.stats?.score ?? null,
        total_punches: s.stats?.total_punches ?? null,
        avg_speed: s.stats?.avg_speed ?? null,
        max_speed: s.stats?.max_speed ?? null,
        avg_reaction_ms: s.stats?.avg_reaction_ms ?? null,
        best_reaction_ms: s.stats?.best_reaction_ms ?? null,
        accuracy: s.stats?.accuracy ?? null,
        badge: s.coach?.badge ?? null,
      }));
  }

  async playerMetrics(playerId: string): Promise<PlayerMetrics> {
    return aggregatePlayer(this.events.filter((e) => e.player_id === playerId));
  }

  async benchmarks(sport: string): Promise<Benchmark[]> {
    return this.benchmarkRows.filter((b) => b.sport === sport).map((b) => ({ ...b }));
  }

  /**
   * Mock mode cannot execute SQL. The SQL has already passed the guard; return the leaderboard
   * so the /api/ask flow is demonstrable offline.
   */
  async runReadOnlyQuery(_sql: string, rowLimit: number): Promise<Record<string, unknown>[]> {
    const rows = await this.leaderboard(Math.min(rowLimit, 10));
    return rows.map((r) => ({ ...r }));
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
