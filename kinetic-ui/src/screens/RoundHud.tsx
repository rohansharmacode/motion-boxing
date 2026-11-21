import { memo, useEffect, useRef, useState } from 'react';
import type { HudStore } from '../hudStore';
import { useHud } from '../hudStore';
import { cx, usePrefersReducedMotion } from '../components/ui';
import { DroneIcon } from '../components/art';

export interface RoundHudProps {
  store: HudStore;
  playerName: string;
  opponentName?: string;
  /** Centre of the screen stays clear for the 3D scene behind this overlay. */
  scene?: React.ReactNode;
}

export function RoundHud({ store, playerName, opponentName = 'UNIT-07', scene }: RoundHudProps) {
  return (
    <ShakeLayer store={store}>
      <div className="absolute inset-0">{scene ?? <div className="h-full w-full bg-[radial-gradient(ellipse_at_50%_40%,#202a66,#0B1026_70%)]" />}</div>
      <HitVignette store={store} />
      <div className="pointer-events-none absolute inset-0 p-6">
        <div className="flex items-start justify-between gap-6">
          <HealthBar store={store} side="player" name={playerName} />
          <RoundTimer store={store} />
          <HealthBar store={store} side="opponent" name={opponentName} />
        </div>
        <div className="absolute bottom-6 left-6"><PunchGauge store={store} /></div>
        <div className="absolute bottom-6 right-6 flex items-end gap-5"><ComboCounter store={store} /><GuardMeter store={store} /></div>
        <Telegraph store={store} />
        <PopText store={store} />
      </div>
    </ShakeLayer>
  );
}

function ShakeLayer({ store, children }: { store: HudStore; children: React.ReactNode }) {
  const seq = useHud(store, (s) => s.bigHitSeq);
  const reduced = usePrefersReducedMotion();
  return <div key={reduced ? 0 : seq} className={cx('relative h-full w-full overflow-hidden', seq > 0 && !reduced && 'shake')}>{children}</div>;
}

const HitVignette = memo(function HitVignette({ store }: { store: HudStore }) {
  const seq = useHud(store, (s) => s.hitSeq);
  if (!seq) return null;
  return <div key={seq} className="vignette-hit pointer-events-none absolute inset-0 z-10 shadow-[inset_0_0_220px_60px_rgb(255_30_60/.75)]" />;
});

const HealthBar = memo(function HealthBar({ store, side, name }: { store: HudStore; side: 'player' | 'opponent'; name: string }) {
  const hp = useHud(store, (s) => Math.round(side === 'player' ? s.playerHp : s.opponentHp));
  const [lag, setLag] = useState(hp);
  useEffect(() => { const t = setTimeout(() => setLag(hp), 450); return () => clearTimeout(t); }, [hp]);
  const p = side === 'player';
  const low = hp <= 25;
  return (
    <div className={cx('flex w-[38%] flex-col gap-2', !p && 'items-end')}>
      <div className={cx('skew-panel flex items-center px-5 py-1', p ? 'bg-cyan text-navy' : 'bg-pink text-navy')}>
        <span className="flex items-center gap-2 font-display text-xl font-bold uppercase tracking-wider">
          {!p && <DroneIcon className="h-6 w-6" />}{name}<span className="tnum ml-2 opacity-80">{hp}</span>
        </span>
      </div>
      <div className={cx('skew-panel relative h-7 w-full overflow-hidden border-2 bg-navy/80', p ? 'glow-cyan border-cyan' : 'glow-pink border-pink')}
        role="meter" aria-label={`${name} health`} aria-valuenow={hp} aria-valuemin={0} aria-valuemax={100}>
        <div className={cx('absolute inset-y-0 bg-white/80 transition-[width] duration-500 ease-out', p ? 'left-0' : 'right-0')} style={{ width: `${Math.max(lag, hp)}%` }} />
        <div className={cx('absolute inset-y-0 transition-[width] duration-100', p ? 'left-0' : 'right-0', low ? 'bg-amber' : p ? 'bg-cyan' : 'bg-pink')} style={{ width: `${hp}%` }} />
      </div>
    </div>
  );
});

const RoundTimer = memo(function RoundTimer({ store }: { store: HudStore }) {
  const secs = useHud(store, (s) => Math.max(0, Math.ceil(s.timeLeftMs / 1000)));
  const round = useHud(store, (s) => s.round);
  const danger = secs < 10;
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={cx('skew-panel border-2 bg-navy/90 px-6 py-1', danger ? 'glow-pink border-pink' : 'border-white/40')}>
        <span className={cx('tnum font-display text-5xl font-bold', danger ? 'timer-pulse text-pink' : 'text-white')}>{mm}:{ss}</span>
      </div>
      <span className="font-display text-base font-bold uppercase tracking-[.3em] text-muted">Round {round}</span>
    </div>
  );
});

/** Arc gauge; animates with rAF writing straight to the DOM, so no React renders per frame. */
const MAX_SW = 5;
const ARC = Math.PI * 70;
const PunchGauge = memo(function PunchGauge({ store }: { store: HudStore }) {
  const punch = useHud(store, (s) => s.lastPunch);
  const seq = useHud(store, (s) => s.punchSeq);
  const arcRef = useRef<SVGPathElement>(null);
  const numRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!punch) return;
    const peak = Math.min(MAX_SW, punch.speed);
    const t0 = performance.now();
    let raf = 0;
    const frame = (t: number) => {
      const k = Math.max(0, 1 - (t - t0) / 1400);
      const v = peak * (t - t0 < 80 ? (t - t0) / 80 : k);
      arcRef.current?.setAttribute('stroke-dashoffset', String(ARC * (1 - v / MAX_SW)));
      if (numRef.current) numRef.current.textContent = v.toFixed(1);
      if (k > 0) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [seq, punch]);
  return (
    <div className="flex items-end gap-4">
      <div className="relative h-24 w-44">
        <svg viewBox="0 0 160 90" className="absolute inset-0 h-full w-full">
          <path d="M10 85 A70 70 0 0 1 150 85" stroke="rgb(139 150 201 / .3)" strokeWidth="12" fill="none" strokeLinecap="round" />
          <path ref={arcRef} d="M10 85 A70 70 0 0 1 150 85" stroke="url(#g)" strokeWidth="12" fill="none" strokeLinecap="round" strokeDasharray={ARC} strokeDashoffset={ARC} />
          <defs><linearGradient id="g"><stop offset="0" stopColor="#22E5FF" /><stop offset=".7" stopColor="#C8FF3D" /><stop offset="1" stopColor="#FF2E88" /></linearGradient></defs>
        </svg>
        <div className="absolute inset-x-0 bottom-0 text-center">
          <span ref={numRef} className="tnum font-display text-4xl font-bold text-white">0.0</span>
          <span className="ml-1 font-display text-sm font-bold text-muted">SW/s</span>
        </div>
      </div>
      <div className="skew-panel mb-2 border-2 border-cyan bg-navy/85 px-4 py-1">
        <span key={seq} className="pop-in block font-display text-2xl font-bold text-cyan">{punch?.type ?? '—'}</span>
      </div>
    </div>
  );
});

const GuardMeter = memo(function GuardMeter({ store }: { store: HudStore }) {
  const g = useHud(store, (s) => Math.round(s.guardPct));
  const tone = g >= 60 ? 'bg-lime' : g >= 30 ? 'bg-amber' : 'bg-pink';
  return (
    <div className="flex flex-col items-center gap-1" role="meter" aria-label="Guard" aria-valuenow={g} aria-valuemin={0} aria-valuemax={100}>
      <div className="relative h-28 w-8 overflow-hidden border-2 border-white/50 bg-navy/80">
        <div className={cx('absolute inset-x-0 bottom-0 transition-[height] duration-150', tone)} style={{ height: `${g}%` }} />
      </div>
      <span className="tnum font-display text-lg font-bold">{g}%</span>
      <span className="font-display text-xs font-bold uppercase tracking-widest text-muted">Guard</span>
    </div>
  );
});

const ComboCounter = memo(function ComboCounter({ store }: { store: HudStore }) {
  const combo = useHud(store, (s) => s.combo);
  if (combo < 2) return <div className="w-32" />;
  const size = Math.min(7, 3.5 + combo * 0.35);
  return (
    <div className="flex w-32 flex-col items-center">
      <span key={combo} className="pop-in tnum font-display font-bold italic text-lime text-glow-lime" style={{ fontSize: `${size}rem`, lineHeight: 1 }}>x{combo}</span>
      <span className="font-display text-sm font-bold uppercase tracking-widest text-lime">Combo</span>
    </div>
  );
});

const Telegraph = memo(function Telegraph({ store }: { store: HudStore }) {
  const at = useHud(store, (s) => s.telegraphAt);
  if (at == null) return null;
  return (
    <div className="absolute right-[22%] top-[30%] h-28 w-28" aria-label="Incoming attack">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r="42" stroke="rgb(255 46 136 / .3)" strokeWidth="8" fill="none" />
        <circle cx="50" cy="50" r="42" stroke="#FF2E88" strokeWidth="8" fill="none" strokeDasharray={264} strokeDashoffset={264}
          style={{ animation: 'telegraph 600ms linear forwards' }} />
      </svg>
      <style>{'@keyframes telegraph{to{stroke-dashoffset:0}}'}</style>
      <span className="absolute inset-0 grid place-items-center font-display text-2xl font-bold text-pink text-glow-pink">!</span>
    </div>
  );
});

const POP: Record<string, string> = { BLOCK: 'text-cyan text-glow-cyan', SLIP: 'text-lime text-glow-lime', HIT: 'text-pink text-glow-pink', COUNTER: 'text-amber' };
const PopText = memo(function PopText({ store }: { store: HudStore }) {
  const ev = useHud(store, (s) => s.event);
  const seq = useHud(store, (s) => s.eventSeq);
  if (!ev) return null;
  if (ev === 'KO')
    return <div key={seq} className="absolute inset-0 grid place-items-center bg-navy/50"><span className="pop-in font-display text-[12rem] font-bold italic text-pink text-glow-pink">K.O.!</span></div>;
  return (
    <div className="absolute inset-x-0 top-[38%] flex justify-center">
      <span key={seq} className={cx('pop-text font-display text-8xl font-bold italic', POP[ev])}>{ev}!</span>
    </div>
  );
});
