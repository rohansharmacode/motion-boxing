// "Hold stance" calibration overlay. Transparent in the middle so the webcam / scene shows through.
//
//   const cal = new CalibrationOverlay(container, { sport: 'BOXING', playerName: 'NAMAN' });
//   cal.setWarning('too_dark');          // or 'too_close' | 'no_person' | null
//   cal.setProgress(validFrames / 15);   // caller-driven 0..1 ...
//   cal.setHolding(guardUp);             // ...or let the ring animate itself over 2 s (resets on false)
//   await cal.complete();                // LOCKED IN, then fades out and removes itself
//   cal.destroy();                       // remove immediately (same as cancel())

import type { Sport } from '../api/types';
import { el, ensurePositioned, html, leave, prefersReducedMotion, wait } from './dom';

export type CalibrationState = 'searching' | 'holding' | 'locked';
export type CalibrationWarning = 'too_dark' | 'too_close' | 'no_person' | 'hands_hidden' | 'shoulders_hidden';

export interface CalibrationOverlayOptions {
  sport?: Sport;
  playerName?: string;
  /** Hold time used by setHolding(). Default 2000 ms. */
  holdMs?: number;
  /** Fired once when setHolding(true) has been held for holdMs. */
  onHeld?: () => void;
}

const COPY: Record<Sport, { title: string; sub: string }> = {
  BOXING: { title: 'Step back, raise your guard', sub: 'Gloves up by your cheeks. Head and both shoulders in frame.' },
  GOALKEEPER: { title: 'Step back, hands ready', sub: 'Hands out wide at chest height. Shoulders in frame.' },
  ARCHERY: { title: 'Step back, square up', sub: 'Stand side-on to the screen, both arms relaxed.' },
};

const SUB: Record<CalibrationState, string | null> = {
  searching: null, // sport copy
  holding: 'Hold it there…',
  locked: 'Calibrated to your shoulder width.',
};

const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

const WARNINGS: Record<CalibrationWarning, { text: string; icon: string }> = {
  too_dark: {
    text: 'Too dark — face a light',
    icon: `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>`,
  },
  too_close: {
    text: 'Too close — step back',
    icon: `<svg ${ICON_ATTRS}><circle cx="8" cy="5.5" r="2.5"/><path d="M4 21v-6a4 4 0 0 1 8 0v6"/><path d="M15 12h7M19 9l3 3-3 3"/></svg>`,
  },
  hands_hidden: {
    text: 'Raise both fists so we can see them',
    icon: `<svg ${ICON_ATTRS}><path d="M7 21v-8l-2-3V6a2 2 0 0 1 4 0v3M17 21v-8l2-3V6a2 2 0 0 0-4 0v3"/><path d="M12 3v3M10.5 4.5 12 3l1.5 1.5"/></svg>`,
  },
  shoulders_hidden: {
    text: 'Show both shoulders — face the camera',
    icon: `<svg ${ICON_ATTRS}><circle cx="12" cy="6.5" r="3"/><path d="M4 21v-3a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v3"/></svg>`,
  },
  no_person: {
    text: 'No one in frame',
    icon: `<svg ${ICON_ATTRS}><circle cx="12" cy="7" r="3"/><path d="M6 21v-3a6 6 0 0 1 12 0v3"/><path d="M3 3l18 18"/></svg>`,
  },
};

const R = 46; // ring radius in the 100x100 viewBox
const CIRC = 2 * Math.PI * R;

// Original line art: head, shoulders, elbows tucked, both gloves raised to the cheeks.
const SILHOUETTE = `
  <svg viewBox="0 0 100 100" aria-hidden="true">
    <circle class="kr-calib-ring-bg" cx="50" cy="50" r="${R}"/>
    <circle class="kr-calib-ring" cx="50" cy="50" r="${R}" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"/>
    <g class="kr-calib-silhouette" transform="translate(50 50) scale(0.74) translate(-50 -56)">
      <ellipse cx="50" cy="31" rx="8.5" ry="10.5"/>
      <path d="M45.5 41v5M54.5 41v5"/>
      <path d="M18 96V73q0-15 15-19l12-4q5 2 10 0l12 4q15 4 15 19v23"/>
      <path d="M31 56q-7 6-6 15l7-24"/>
      <path d="M69 56q7 6 6 15l-7-24"/>
    </g>
    <circle class="kr-calib-hand" cx="${50 - 0.74 * 16}" cy="${50 + 0.74 * (37 - 56)}" r="6.5"/>
    <circle class="kr-calib-hand" cx="${50 + 0.74 * 16}" cy="${50 + 0.74 * (37 - 56)}" r="6.5"/>
  </svg>`;

export class CalibrationOverlay {
  readonly element: HTMLElement;
  private readonly sport: Sport;
  private readonly holdMs: number;
  private readonly onHeld?: () => void;
  private readonly ring: SVGCircleElement;
  private readonly title = el('div', { class: 'kr-calib-title' });
  private readonly sub = el('div', { class: 'kr-calib-sub' });
  private readonly chip = el('span', { class: 'kr-chip kr-calib-chip' });
  private readonly warnText = el('span', { class: 'kr-calib-warn-text' });
  private readonly warnIcon = el('span', { class: 'kr-calib-warn-icon' });
  private readonly warnBox: HTMLElement;
  private state: CalibrationState | null = null;
  private warning: CalibrationWarning | null = null;
  private progress = -1;
  private holding = false;
  private holdStart = 0;
  private raf = 0;
  private done = false;

  constructor(parent: HTMLElement, opts: CalibrationOverlayOptions = {}) {
    this.sport = opts.sport ?? 'BOXING';
    this.holdMs = opts.holdMs ?? 2000;
    this.onHeld = opts.onHeld;

    const svg = html(SILHOUETTE);
    this.ring = svg.querySelector<SVGCircleElement>('.kr-calib-ring')!;
    this.warnBox = el('div', { class: 'kr-calib-warn', role: 'alert', hidden: '' }, this.warnIcon, this.warnText);

    // Minimal setup: a faint silhouette inside the progress ring and two circles for the gloves.
    // Warnings (too close, hands hidden...) still appear, only when something is wrong.
    this.element = el(
      'section',
      { class: 'kr-screen kr-calib kr-calib2 kr-calib-min', 'data-state': 'searching', 'aria-live': 'polite' },
      el('div', { class: 'kr-calib-frame' }, svg),
      this.warnBox,
    );

    ensurePositioned(parent);
    parent.append(this.element);
    this.setState('searching');
    this.render(0);
  }

  setState(s: CalibrationState): void {
    if (s === this.state || (this.done && s !== 'locked')) return;
    this.state = s;
    this.element.dataset.state = s;
    this.title.textContent = s === 'locked' ? 'Locked in' : COPY[this.sport].title;
    this.sub.textContent = SUB[s] ?? COPY[this.sport].sub;
    this.renderChip();
  }

  /** Caller-driven progress, e.g. validFrames / 15. Stops any setHolding() animation. */
  setProgress(p: number): void {
    if (this.done) return;
    this.stopHold();
    this.render(p);
    this.setState(this.progress > 0 ? 'holding' : 'searching');
  }

  /** Self-animating 2 s hold: true starts the ring, false resets it to 0. */
  setHolding(isHolding: boolean): void {
    if (this.done || isHolding === this.holding) return;
    this.holding = isHolding;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (!isHolding) {
      this.render(0);
      this.setState('searching');
      return;
    }
    this.holdStart = performance.now();
    this.setState('holding');
    const tick = (now: number) => {
      const p = (now - this.holdStart) / this.holdMs;
      this.render(p);
      if (p >= 1) {
        this.raf = 0;
        this.onHeld?.();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  setWarning(w: CalibrationWarning | null): void {
    if (w === this.warning) return;
    this.warning = w;
    this.element.dataset.warning = w ?? '';
    this.warnBox.hidden = !w;
    if (w) {
      this.warnIcon.replaceChildren(html(WARNINGS[w].icon));
      this.warnText.textContent = WARNINGS[w].text;
    }
  }

  /** Shows LOCKED IN, then fades out and removes itself. */
  async complete(): Promise<void> {
    if (this.done) return;
    this.stopHold();
    this.setWarning(null);
    this.render(1);
    this.setState('locked');
    this.done = true;
    await wait(prefersReducedMotion() ? 500 : 850);
    if (this.element.isConnected) await leave(this.element);
  }

  /** Remove immediately. */
  destroy(): void {
    this.done = true;
    this.stopHold();
    this.element.remove();
  }

  /** Alias of destroy() (legacy name). */
  cancel(): void {
    this.destroy();
  }

  private stopHold() {
    this.holding = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private render(p: number) {
    const v = Math.max(0, Math.min(1, p));
    if (Math.abs(v - this.progress) < 0.001) return;
    this.progress = v;
    this.ring.style.strokeDashoffset = String(CIRC * (1 - v));
    this.renderChip();
  }

  private renderChip() {
    const t =
      this.state === 'locked' ? 'Ready' : this.progress > 0 ? `Hold · ${Math.round(this.progress * 100)}%` : 'Waiting for guard';
    if (this.chip.textContent !== t) this.chip.textContent = t;
  }
}
