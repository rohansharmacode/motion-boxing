// In-round boxing HUD overlay: HP bars, round timer, combo, punch speed, guard meter, pop text.
// Safe to call update() every frame: the DOM is only touched when a displayed value changes.
//
//   const hud = new BoxingHUD(container, { playerName: 'NAMAN', opponentName: 'UNIT-07' });
//   hud.update({ playerHp: 80, opponentHp: 55, timeLeftMs: 31000, round: 1, guardPct: 72 });
//   hud.punch({ type: 'HOOK', speed: 3.1, landed: true });   // speed gauge + combo +1
//   hud.pop('BLOCK');                                         // 'BLOCK' | 'SLIP' | 'KO' | 'HIT' | any text
//   hud.playerHit();                                          // pink vignette, combo reset
//   hud.destroy();

import { el, ensurePositioned, fmtClock, prefersReducedMotion } from './dom';

export interface BoxingHUDOptions {
  playerName?: string;
  opponentName?: string;
  maxHp?: number;
  /** Speed that fills the gauge, in shoulder-widths per second. Default 5. */
  maxSpeed?: number;
  /** Initial timer value. Default 60 000 ms. */
  roundMs?: number;
}

export interface BoxingHUDState {
  playerHp: number;
  opponentHp: number;
  timeLeftMs: number;
  round: number;
  combo: number;
  /** 0..100 */
  guardPct: number;
}

export interface PunchInfo {
  type?: string;
  /** SW/s */
  speed: number;
  landed?: boolean;
}

export type PopKind = 'BLOCK' | 'SLIP' | 'KO' | 'HIT' | (string & {});

const POPS: Record<string, { text: string; cls: string; ms: number }> = {
  BLOCK: { text: 'Block!', cls: 'block', ms: 750 },
  SLIP: { text: 'Slip!', cls: 'slip', ms: 750 },
  HIT: { text: 'Hit!', cls: 'hit', ms: 600 },
  KO: { text: 'KO!', cls: 'ko', ms: 1700 },
};

interface FighterBar {
  root: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  lag: HTMLElement;
  num: HTMLElement;
  hp: number;
  low: boolean;
}

const restart = (node: Element, cls: string) => {
  node.classList.remove(cls);
  void (node as HTMLElement).offsetWidth; // restart CSS animation (only on change, never per frame)
  node.classList.add(cls);
};

export class BoxingHUD {
  readonly element: HTMLElement;
  private readonly maxHp: number;
  private readonly maxSpeed: number;
  private readonly me: FighterBar;
  private readonly foe: FighterBar;
  private readonly timer = el('div', { class: 'kr-timer' });
  private readonly timerValue = el('div', { class: 'kr-timer-value' });
  private readonly timerLabel = el('div', { class: 'kr-timer-label' });
  private readonly combo = el('div', { class: 'kr-combo' });
  private readonly comboNum = el('div', { class: 'kr-combo-num' });
  private readonly speedType = el('span', { class: 'kr-speed-type' });
  private readonly speedNum = el('span', {}, '0.0');
  private readonly speedFill = el('div');
  private readonly speedBest = el('div', { class: 'kr-speed-best' }, 'Best 0.0');
  private readonly speedMiss = el('span', { class: 'kr-speed-miss' }, 'Miss');
  private readonly guard = el('div', { class: 'kr-guard', role: 'meter', 'aria-label': 'Guard', 'aria-valuemin': '0', 'aria-valuemax': '100' });
  private readonly guardFill = el('div', { class: 'kr-guard-fill' });
  private readonly guardNum = el('b', {}, '0%');
  private readonly pops = el('div', { class: 'kr-pops', 'aria-live': 'assertive' });
  private readonly bannerBox = el('div', { class: 'kr-hud-banner', 'aria-live': 'polite' });
  private readonly modeBox = el('div', { class: 'kr-hud-mode' });
  private readonly vignette = el('div', { class: 'kr-hud-vignette' });
  private readonly shaker: HTMLElement;

  private clock = '';
  private urgent = false;
  private round = 0;
  private comboCount = -1;
  private guardVal = -1;
  private guardTier = '';
  private best = 0;
  private speedTimer = 0;
  private timers = new Set<number>();

  constructor(parent: HTMLElement, opts: BoxingHUDOptions = {}) {
    this.maxHp = opts.maxHp ?? 100;
    this.maxSpeed = opts.maxSpeed ?? 5;
    this.me = this.fighter(opts.playerName ?? 'You', 'left');
    this.foe = this.fighter(opts.opponentName ?? 'Unit-07', 'right');

    this.timer.append(this.timerValue, this.timerLabel);
    this.combo.append(this.comboNum, el('div', { class: 'kr-combo-label' }, 'Combo'));
    this.guard.append(
      el('div', { class: 'kr-guard-head' }, el('span', {}, 'Guard'), this.guardNum),
      el('div', { class: 'kr-guard-bar' }, this.guardFill),
    );
    const speed = el(
      'div',
      { class: 'kr-speed' },
      el('div', { class: 'kr-speed-head' }, el('span', { class: 'kr-speed-label' }, 'Punch speed'), this.speedMiss, this.speedType),
      el('div', { class: 'kr-speed-value' }, this.speedNum, el('small', {}, 'SW/s')),
      el('div', { class: 'kr-speed-bar' }, this.speedFill),
      this.speedBest,
    );

    this.shaker = el(
      'div',
      { class: 'kr-bhud-shaker' },
      el('div', { class: 'kr-hud-top' }, this.me.root, this.timer, this.foe.root),
      this.modeBox,
      this.bannerBox,
      this.pops,
      el('div', { class: 'kr-hud-bottom' }, this.combo, this.guard, speed),
    );
    this.element = el('div', { class: 'kr-hud kr-bhud' }, this.vignette, this.shaker);

    ensurePositioned(parent);
    parent.append(this.element);
    this.update({ playerHp: this.maxHp, opponentHp: this.maxHp, timeLeftMs: opts.roundMs ?? 60000, round: 1, combo: 0 });
  }

  update(s: Partial<BoxingHUDState>): void {
    if (s.playerHp !== undefined) this.setHp(this.me, s.playerHp);
    if (s.opponentHp !== undefined) this.setHp(this.foe, s.opponentHp);
    if (s.timeLeftMs !== undefined) {
      const c = fmtClock(s.timeLeftMs);
      if (c !== this.clock) {
        this.clock = c;
        this.timerValue.textContent = c;
      }
      const u = s.timeLeftMs < 10000;
      if (u !== this.urgent) {
        this.urgent = u;
        this.timer.classList.toggle('kr-urgent', u);
      }
    }
    if (s.round !== undefined && s.round !== this.round) {
      this.round = s.round;
      this.timerLabel.textContent = `Round ${s.round}`;
    }
    if (s.combo !== undefined) this.setCombo(s.combo);
    if (s.guardPct !== undefined) this.setGuard(s.guardPct);
  }

  /** Show the last punch. Also bumps the combo (landed) or resets it (missed); update({combo}) overrides. */
  punch(p: PunchInfo): void {
    const landed = p.landed !== false;
    this.speedType.textContent = p.type ?? '';
    this.speedMiss.classList.toggle('kr-on', !landed);
    this.speedNum.textContent = p.speed.toFixed(1);
    this.speedFill.style.transform = `scaleX(${Math.min(1, Math.max(0, p.speed / this.maxSpeed))})`;
    if (p.speed > this.best) {
      this.best = p.speed;
      this.speedBest.textContent = `Best ${this.best.toFixed(1)}`;
      restart(this.speedBest, 'kr-flash');
    }
    clearTimeout(this.speedTimer);
    this.speedTimer = window.setTimeout(() => (this.speedFill.style.transform = 'scaleX(0)'), 900);
    this.setCombo(landed ? Math.max(0, this.comboCount) + 1 : 0);
  }

  /** Big italic pop text. KO is bigger, longer and shakes the HUD. */
  pop(kind: PopKind): void {
    const preset = POPS[kind.toUpperCase()];
    const text = preset?.text ?? kind;
    const ms = preset?.ms ?? 900;
    const node = el('div', { class: `kr-popx kr-popx-${preset?.cls ?? 'custom'}`, 'data-text': text }, text);
    const reduced = prefersReducedMotion();
    if (reduced) node.classList.add('kr-popx-static');
    while (this.pops.childElementCount >= 3) this.pops.firstElementChild!.remove();
    for (const prev of this.pops.children) prev.classList.add('kr-popx-out'); // older pops get out of the way
    this.pops.append(node);
    if (preset?.cls === 'ko' && !reduced) restart(this.shaker, 'kr-ko-shake');
    this.later(() => node.remove(), ms);
  }

  playerHit(): void {
    this.setCombo(0);
    this.vignette.classList.add('kr-hurt');
    this.later(() => this.vignette.classList.remove('kr-hurt'), 180);
  }

  /** Legacy skewed strip banner (e.g. "Incoming!"). */
  banner(text: string, tone: 'good' | 'bad' = 'bad'): void {
    const span = el('span', { class: tone === 'good' ? 'kr-good' : '' }, text);
    if (prefersReducedMotion()) span.classList.add('kr-popx-static');
    this.bannerBox.replaceChildren(span);
    this.later(() => span.remove(), 900);
  }

  setMode(label: string | null): void {
    this.modeBox.replaceChildren(...(label ? [el('span', { class: 'kr-chip' }, label)] : []));
  }

  destroy(): void {
    clearTimeout(this.speedTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.element.remove();
  }

  // ---- internals ----

  private fighter(name: string, side: 'left' | 'right'): FighterBar {
    const fill = el('div', { class: 'kr-hp-fill' });
    const lag = el('div', { class: 'kr-hp-lag' });
    const bar = el(
      'div',
      { class: 'kr-hp', role: 'meter', 'aria-label': `${name} health`, 'aria-valuemin': '0', 'aria-valuemax': String(this.maxHp) },
      lag,
      fill,
    );
    const num = el('span', { class: 'kr-hp-num' });
    const root = el('div', { class: `kr-fighter kr-${side}` }, el('div', { class: 'kr-fighter-name' }, el('span', {}, name), num), bar);
    return { root, bar, fill, lag, num, hp: NaN, low: false };
  }

  private setHp(f: FighterBar, hp: number) {
    const v = Math.max(0, Math.min(this.maxHp, hp));
    if (v === f.hp) return;
    if (v < f.hp) restart(f.bar, 'kr-hit');
    const firstOrHeal = !(v < f.hp);
    f.hp = v;
    const scale = `scaleX(${v / this.maxHp})`;
    f.fill.style.transform = scale;
    // White damage trail: lags behind on damage, snaps on heal / first paint.
    f.lag.classList.toggle('kr-snap', firstOrHeal);
    f.lag.style.transform = scale;
    const shown = String(Math.ceil(v));
    if (f.num.textContent !== shown) {
      f.num.textContent = shown;
      f.bar.setAttribute('aria-valuenow', shown);
    }
    const low = v / this.maxHp <= 0.25;
    if (low !== f.low) {
      f.low = low;
      f.bar.classList.toggle('kr-low', low);
    }
  }

  private setCombo(n: number) {
    if (n === this.comboCount) return;
    const up = n > this.comboCount;
    this.comboCount = n;
    this.comboNum.textContent = `x${n}`;
    this.combo.classList.toggle('kr-on', n >= 2);
    if (up && n >= 2) restart(this.comboNum, 'kr-bump');
  }

  private setGuard(pct: number) {
    const v = Math.round(Math.max(0, Math.min(100, pct)));
    if (v === this.guardVal) return;
    if (this.guardVal < 0) this.guard.classList.add('kr-on'); // hidden until the game reports guard
    this.guardVal = v;
    this.guardNum.textContent = `${v}%`;
    this.guardFill.style.transform = `scaleX(${v / 100})`;
    this.guard.style.setProperty('--gp', String(v)); // ring skins read this
    this.guard.setAttribute('aria-valuenow', String(v));
    const tier = v < 35 ? 'low' : v < 65 ? 'mid' : 'ok';
    if (tier !== this.guardTier) {
      if (this.guardTier) this.guard.classList.remove(`kr-guard-${this.guardTier}`);
      this.guard.classList.add(`kr-guard-${tier}`);
      this.guardTier = tier;
    }
  }

  private later(fn: () => void, ms: number) {
    const t = window.setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }
}
