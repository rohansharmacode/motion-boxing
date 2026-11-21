// "Live from Snowflake" highlights ticker: one line at a time from GET /api/highlights (Streams +
// Tasks write T_HIGHLIGHTS), e.g. "Kestrel · new fastest punch 4.6 SW/s · 2 min ago".
//
//   const ticker = new HighlightsTicker(parent)   // or mountHighlightsTicker(parent) for a { dispose }
//   ticker.destroy()
//
// Refreshes every refreshMs, rotates every rotateMs, hides itself when there is nothing to show.

import './styles.css';
import './components.css';
import { getHighlights } from '../api/client';
import type { Highlight, ApiSource } from '../api/types';
import { el, html, prefersReducedMotion } from './dom';

const BOLT = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>`;

export interface HighlightsTickerOptions {
  limit?: number;
  refreshMs?: number;
  rotateMs?: number;
  /** Highlight this player's own entries. */
  playerId?: string;
}

/** "just now", "3 min ago", "2 h ago". */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Player-facing text for a highlight. Units are shoulder-widths per second (the server's m/s label is wrong). */
export function highlightText(h: Pick<Highlight, 'kind' | 'value' | 'name'>): string {
  const v = h.value ?? 0;
  switch (h.kind) {
    case 'speed_record':
      return `${h.name} · new fastest punch ${v.toFixed(1)} SW/s`;
    case 'personal_best_speed':
      return `${h.name} · personal best ${v.toFixed(1)} SW/s`;
    case 'reaction_record':
      return `${h.name} · fastest reaction ${Math.round(v)} ms`;
    case 'punch_milestone':
      return `${h.name} · ${Math.round(v).toLocaleString('en-US')} punches thrown`;
    default:
      return `${h.name} · ${h.kind.replace(/_/g, ' ')}`;
  }
}

export class HighlightsTicker {
  readonly element: HTMLElement;
  private readonly line: HTMLElement;
  private readonly when: HTMLElement;
  private readonly chip: HTMLElement;
  private items: Highlight[] = [];
  private index = 0;
  private source: ApiSource = 'mock';
  private refreshTimer = 0;
  private rotateTimer = 0;
  private destroyed = false;
  private paused = false;
  private readonly opts: Required<Omit<HighlightsTickerOptions, 'playerId'>> & { playerId?: string };

  constructor(parent: HTMLElement, opts: HighlightsTickerOptions = {}) {
    this.opts = { limit: opts.limit ?? 10, refreshMs: opts.refreshMs ?? 10_000, rotateMs: opts.rotateMs ?? 4_000, playerId: opts.playerId };
    this.chip = el('span', { class: 'kr-hl-chip' }, 'Live from Snowflake');
    this.line = el('span', { class: 'kr-hl-line' });
    this.when = el('span', { class: 'kr-hl-when' });
    this.element = el(
      'div',
      { class: 'kr-hl', role: 'status', 'aria-live': 'polite', hidden: '' },
      el('span', { class: 'kr-hl-icon' }, html(BOLT)),
      this.chip,
      el('span', { class: 'kr-hl-body' }, this.line, this.when),
    );
    parent.append(this.element);
    void this.refresh();
    this.refreshTimer = window.setInterval(() => {
      if (!this.paused) void this.refresh();
    }, this.opts.refreshMs);
    this.rotateTimer = window.setInterval(() => {
      if (!this.paused) this.rotate();
    }, this.opts.rotateMs);
  }

  /**
   * Pause while hidden (e.g. a game is running): the intervals stay registered but do no work and
   * make no requests. Resuming fetches straight away.
   */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (!paused) void this.refresh();
  }

  async refresh(): Promise<void> {
    const res = await getHighlights(this.opts.limit);
    if (this.destroyed) return;
    const firstId = this.items[this.index]?.highlight_id;
    this.items = res.highlights;
    this.source = res.source ?? 'mock';
    // Keep showing the same item if it is still there, otherwise start from the newest.
    const keep = this.items.findIndex((h) => h.highlight_id === firstId);
    this.index = keep >= 0 ? keep : 0;
    this.show(false);
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.refreshTimer);
    clearInterval(this.rotateTimer);
    this.element.remove();
  }

  private rotate(): void {
    if (this.items.length < 2) return;
    this.index = (this.index + 1) % this.items.length;
    this.show(true);
  }

  private show(animate: boolean): void {
    const h = this.items[this.index];
    this.element.hidden = !h;
    if (!h) return;
    this.chip.textContent = this.source === 'live' ? 'Live from Snowflake' : 'Highlights · mock';
    this.element.dataset.source = this.source;
    this.line.textContent = highlightText(h);
    this.when.textContent = timeAgo(h.created_at);
    this.element.classList.toggle('kr-hl-mine', !!this.opts.playerId && h.player_id === this.opts.playerId);
    if (animate && !prefersReducedMotion()) {
      this.line.classList.remove('kr-hl-in');
      void this.line.offsetWidth;
      this.line.classList.add('kr-hl-in');
    }
  }
}

/** Shell-friendly wrapper: mount a ticker anywhere and get back { setPaused, dispose }. */
export function mountHighlightsTicker(
  parent: HTMLElement,
  opts: HighlightsTickerOptions = {},
): { setPaused(paused: boolean): void; dispose(): void } {
  const t = new HighlightsTicker(parent, opts);
  return { setPaused: (p) => t.setPaused(p), dispose: () => t.destroy() };
}
