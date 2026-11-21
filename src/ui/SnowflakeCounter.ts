// Live "rows into Snowflake" counter for the in-game HUD.
//
//   const counter = new SnowflakeCounter(parent)
//   counter.resetRound()   // at round start: counts this round's rows from zero
//   counter.destroy()
//
// Driven by src/api/client.ts onUploadStats (event-based: no per-frame work). Live mode counts rows
// the server accepted; mock mode is labelled LOCAL so nobody mistakes it for Snowflake.

import { onUploadStats } from '../api/client';
import type { UploadStats } from '../api/types';
import { el, html } from './dom';

/** Original six-arm flake glyph (not the Snowflake logo). */
const FLAKE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9.5 3.5L12 6l2.5-2.5M9.5 20.5L12 18l2.5 2.5"/></svg>`;

const PULSE_MS = 700;

export class SnowflakeCounter {
  readonly element: HTMLElement;
  private readonly count: HTMLElement;
  private readonly label: HTMLElement;
  private readonly sub: HTMLElement;
  private baseline = 0;
  private last: UploadStats | null = null;
  private lastSentAt = 0;
  private pulseTimer = 0;
  private readonly unsubscribe: () => void;

  constructor(parent: HTMLElement) {
    this.label = el('span', { class: 'kr-sf-label' }, 'Snowflake');
    this.count = el('b', { class: 'kr-sf-count' }, '0');
    this.sub = el('span', { class: 'kr-sf-sub' }, 'rows this round');
    this.element = el(
      'div',
      { class: 'kr-sf', role: 'status', 'aria-live': 'off', 'data-mode': 'live' },
      el('span', { class: 'kr-sf-icon' }, html(FLAKE)),
      el('span', { class: 'kr-sf-text' }, this.label, el('span', { class: 'kr-sf-row' }, this.count, this.sub)),
    );
    parent.append(this.element);
    this.unsubscribe = onUploadStats((s) => this.render(s));
  }

  /** Count this round's rows from zero. */
  resetRound(): void {
    this.baseline = this.last ? this.rowsOf(this.last) : 0;
    if (this.last) this.render(this.last);
  }

  destroy(): void {
    this.unsubscribe();
    clearTimeout(this.pulseTimer);
    this.element.remove();
  }

  private rowsOf(s: UploadStats): number {
    return s.mode === 'mock' ? s.captured : s.sent;
  }

  private render(s: UploadStats): void {
    this.last = s;
    const rows = Math.max(0, this.rowsOf(s) - this.baseline);
    this.element.dataset.mode = s.mode;
    this.count.textContent = rows.toLocaleString('en-US');
    if (s.mode === 'mock') {
      this.label.textContent = 'Local only';
      this.sub.textContent = 'events · no API';
    } else if (s.mode === 'offline') {
      this.label.textContent = 'Snowflake offline';
      this.sub.textContent = `rows · ${s.queued} queued`;
    } else {
      this.label.textContent = 'Live to Snowflake';
      this.sub.textContent = s.queued > 0 ? `rows · ${s.queued} sending` : 'rows this round';
    }
    // Pulse once per accepted batch.
    if (s.mode === 'live' && s.lastSentAt > this.lastSentAt && s.lastBatch > 0) {
      this.lastSentAt = s.lastSentAt;
      this.element.classList.remove('kr-sf-pulse');
      void this.element.offsetWidth;
      this.element.classList.add('kr-sf-pulse');
      clearTimeout(this.pulseTimer);
      this.pulseTimer = window.setTimeout(() => this.element.classList.remove('kr-sf-pulse'), PULSE_MS);
    }
  }
}
