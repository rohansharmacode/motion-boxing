// Full-screen broadcast-style leaderboard with sport tabs and 10 s auto-refresh.
//
//   // From the home dashboard's Leaderboard tile:
//   const session = startLeaderboard(ctx);   // Back / Esc -> ctx.exit()
//   session.dispose();                       // removes DOM, timers and listeners
//
//   // Or directly:
//   const board = new LeaderboardScreen(container, { playerId, onBack: () => goHome() });

// The leaderboard can be the first screen opened from the home menu, so it must load its own styles.
import './styles.css';
import './components.css';
import { getLastPlayer, getLeaderboard } from '../api/client';
import type { LeaderboardEntry, LeaderboardResponse, Sport } from '../api/types';
import { artImg, el, ensurePositioned, html, isTyping, prefersReducedMotion } from './dom';
import { ICONS } from './icons';
import type { GameContext, GameSession } from './shellTypes';

export interface LeaderboardScreenOptions {
  onBack(): void;
  sport?: Sport;
  /** Row to highlight. Falls back to a case-insensitive name match when absent. */
  playerId?: string;
  playerName?: string;
  /** Default 10. */
  limit?: number;
  /** Default 10 000 ms. */
  refreshMs?: number;
  /** Data source. Defaults to getLeaderboard from the API client (never rejects, falls back to mock). */
  load?: (sport: Sport, limit: number) => Promise<LeaderboardResponse>;
}

const SPORTS: { id: Sport; name: string }[] = [
  { id: 'BOXING', name: 'Boxing' },
  { id: 'GOALKEEPER', name: 'Goalkeeper' },
  { id: 'ARCHERY', name: 'Archery' },
];

export class LeaderboardScreen {
  readonly element: HTMLElement;
  private readonly opts: LeaderboardScreenOptions;
  private readonly limit: number;
  private readonly refreshMs: number;
  private readonly load: (sport: Sport, limit: number) => Promise<LeaderboardResponse>;
  private readonly tabs: HTMLButtonElement[];
  private readonly list = el('ol', { class: 'kr-board-list', 'aria-live': 'polite' });
  private readonly source = el('span', { class: 'kr-src kr-src-pending' }, 'Connecting…');
  private readonly updated = el('span', { class: 'kr-board-updated' }, '');
  private readonly refreshBar = el('div', { class: 'kr-board-refresh' });
  private readonly speedHead = el('span', {}, 'Top SW/s');
  private readonly cache = new Map<Sport, LeaderboardResponse>();
  private readonly lastScores = new Map<string, number>();
  private sport: Sport;
  private req = 0;
  private interval = 0;
  private disposed = false;

  constructor(parent: HTMLElement, opts: LeaderboardScreenOptions) {
    this.opts = opts;
    this.sport = opts.sport ?? 'BOXING';
    this.limit = opts.limit ?? 10;
    this.refreshMs = opts.refreshMs ?? 10000;
    this.load = opts.load ?? getLeaderboard;

    const back = el('button', { class: 'kr-btn kr-btn-ghost kr-board-back', type: 'button' }, '← Back ', el('span', { class: 'kr-kbd' }, 'Esc'));
    back.addEventListener('click', () => this.back());

    this.tabs = SPORTS.map((s) => {
      const b = el(
        'button',
        { class: 'kr-board-tab', type: 'button', role: 'tab', 'data-sport': s.id, 'aria-selected': 'false' },
        el('span', { class: 'kr-board-tab-icon' }, html(ICONS[s.id])),
        el('span', {}, s.name),
      );
      b.addEventListener('click', () => this.setSport(s.id));
      return b;
    });

    this.element = el(
      'section',
      { class: 'kr-screen kr-backdrop kr-board', 'aria-label': 'Leaderboard' },
      el(
        'div',
        { class: 'kr-board-inner' },
        el(
          'header',
          { class: 'kr-board-head' },
          back,
          el(
            'div',
            { class: 'kr-board-title' },
            artImg('tile-leaderboard.svg', 'kr-board-art'),
            el('span', { class: 'kr-live' }, el('span', {}, 'Live standings')),
            el('h1', {}, 'Leader', el('span', {}, 'board')),
          ),
          this.source,
        ),
        el('nav', { class: 'kr-board-tabs', role: 'tablist', 'aria-label': 'Sport' }, ...this.tabs),
        el(
          'div',
          { class: 'kr-board-table' },
          el('div', { class: 'kr-board-cols', 'aria-hidden': 'true' }, el('span', {}, '#'), el('span', {}, 'Player'), this.speedHead, el('span', {}, 'Score')),
          this.list,
        ),
        el(
          'footer',
          { class: 'kr-board-foot' },
          this.updated,
          el('div', { class: 'kr-board-refresh-track', title: 'Auto-refresh' }, this.refreshBar),
          el('span', { class: 'kr-hint' }, 'Auto-refresh every ', String(Math.round(this.refreshMs / 1000)), ' s · ', el('span', { class: 'kr-kbd' }, '←'), ' ', el('span', { class: 'kr-kbd' }, '→'), ' switch sport'),
        ),
      ),
    );

    ensurePositioned(parent);
    parent.append(this.element);
    window.addEventListener('keydown', this.onKey);
    this.setSport(this.sport, true);
    this.interval = window.setInterval(() => void this.refresh(), this.refreshMs);
  }

  setSport(sport: Sport, force = false): void {
    if (this.disposed || (sport === this.sport && !force)) return;
    this.sport = sport;
    for (const t of this.tabs) t.setAttribute('aria-selected', String(t.dataset.sport === sport));
    this.lastScores.clear();
    const cached = this.cache.get(sport);
    if (cached) this.render(cached, true);
    else this.skeleton();
    void this.refresh();
  }

  /** Fetch the current sport now (also called by the auto-refresh timer). */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const id = ++this.req;
    const sport = this.sport;
    this.restartBar();
    let res: LeaderboardResponse;
    try {
      res = await this.load(sport, this.limit);
    } catch (err) {
      if (this.disposed || id !== this.req) return;
      console.warn('[ui] leaderboard load failed', err);
      if (!this.cache.has(sport)) this.list.replaceChildren(el('li', { class: 'kr-board-empty' }, 'Leaderboard offline. Retrying…'));
      this.setSource('offline');
      return;
    }
    if (this.disposed || id !== this.req) return; // stale (tab switched / disposed)
    const first = !this.cache.has(sport);
    this.cache.set(sport, res);
    this.render(res, first);
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.interval);
    window.removeEventListener('keydown', this.onKey);
    this.element.remove();
  }

  /** GameSession-style alias. */
  dispose(): void {
    this.destroy();
  }

  // ---- internals ----

  private back() {
    this.destroy();
    this.opts.onBack();
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.back();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const i = SPORTS.findIndex((s) => s.id === this.sport);
      const next = SPORTS[(i + (e.key === 'ArrowRight' ? 1 : SPORTS.length - 1)) % SPORTS.length];
      this.setSport(next.id);
      this.tabs.find((t) => t.dataset.sport === next.id)?.focus({ preventScroll: true });
    }
  };

  private isMe(r: LeaderboardEntry) {
    const { playerId, playerName } = this.opts;
    if (playerId) return r.player_id === playerId;
    return !!playerName && r.display_name.trim().toLowerCase() === playerName.trim().toLowerCase();
  }

  private skeleton() {
    this.list.replaceChildren(
      ...Array.from({ length: this.limit }, (_, i) =>
        el('li', { class: 'kr-brow kr-brow-skel', style: `--i:${i}` }, el('span', { class: 'kr-skel' }), el('span', { class: 'kr-skel' }), el('span', { class: 'kr-skel' }), el('span', { class: 'kr-skel' })),
      ),
    );
  }

  private render(res: LeaderboardResponse, entrance: boolean) {
    this.setSource(res.source ?? 'live');
    this.updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    const rows = [...res.entries].sort((a, b) => a.rank - b.rank).slice(0, this.limit);
    if (!rows.length) {
      this.list.replaceChildren(el('li', { class: 'kr-board-empty' }, 'No scores yet. Be the first in the ring.'));
      return;
    }
    const prev = new Map(this.lastScores);
    this.lastScores.clear();
    this.list.replaceChildren(
      ...rows.map((r, i) => {
        const key = r.player_id;
        this.lastScores.set(key, r.score);
        const changed = !entrance && prev.size > 0 && prev.get(key) !== r.score;
        const cls = ['kr-brow', entrance ? 'kr-brow-in' : '', changed ? 'kr-brow-new' : '', this.isMe(r) ? 'kr-you' : '', r.rank <= 3 ? `kr-top kr-top-${r.rank}` : '']
          .filter(Boolean)
          .join(' ');
        return el(
          'li',
          { class: cls, style: `--i:${i}` },
          el('span', { class: 'kr-brow-rank' }, el('span', {}, String(r.rank))),
          el('span', { class: 'kr-brow-name' }, el('span', {}, r.display_name), this.isMe(r) ? el('em', {}, 'You') : null),
          el('span', { class: 'kr-brow-speed' }, r.max_speed != null ? r.max_speed.toFixed(1) : '–'),
          el('span', { class: 'kr-brow-score' }, r.score.toLocaleString()),
        );
      }),
    );
  }

  private setSource(s: 'live' | 'mock' | 'offline') {
    const cls = `kr-src kr-src-${s}`;
    if (this.source.className === cls) return;
    this.source.className = cls;
    this.source.textContent = s === 'live' ? 'Live · Snowflake' : s === 'mock' ? 'Mock data' : 'Offline';
  }

  private restartBar() {
    if (prefersReducedMotion()) return;
    this.refreshBar.style.animation = 'none';
    void this.refreshBar.offsetWidth;
    this.refreshBar.style.animation = `kr-refresh ${this.refreshMs}ms linear forwards`;
  }
}

/** Entry point for the home dashboard's Leaderboard tile. */
export function startLeaderboard(ctx: GameContext): GameSession {
  const me = getLastPlayer();
  const board = new LeaderboardScreen(ctx.host, {
    playerId: me?.player_id,
    playerName: me?.display_name,
    onBack: () => ctx.exit(),
  });
  const dispose = () => board.destroy();
  ctx.signal.addEventListener('abort', dispose, { once: true });
  return { dispose };
}
