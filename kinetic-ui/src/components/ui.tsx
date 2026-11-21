import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DataSource } from '../types';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const m = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Counts from 0 to `value` with ease-out. Instant under reduced motion. */
export function useCountUp(value: number, durationMs = 1200, decimals = 0) {
  const reduced = usePrefersReducedMotion();
  const [n, setN] = useState(reduced ? value : 0);
  useEffect(() => {
    if (reduced) { setN(value); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / durationMs);
      setN(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs, reduced]);
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

export function CountUp({ value, decimals = 0, durationMs, className }: { value: number; decimals?: number; durationMs?: number; className?: string }) {
  const n = useCountUp(value, durationMs, decimals);
  return <span className={cx('tnum', className)}>{n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>;
}

type Tone = 'cyan' | 'pink' | 'lime' | 'amber' | 'muted' | 'white';
const toneCls: Record<Tone, string> = {
  cyan: 'border-cyan text-cyan',
  pink: 'border-pink text-pink',
  lime: 'border-lime text-lime',
  amber: 'border-amber text-amber',
  muted: 'border-muted/60 text-muted',
  white: 'border-white/70 text-white',
};

export function Chip({ tone = 'cyan', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('skew-panel inline-flex items-center border-2 bg-navy/70 px-3 py-0.5 font-display text-sm font-bold uppercase tracking-widest', toneCls[tone], className)}>
      <span className="inline-flex items-center gap-2">{children}</span>
    </span>
  );
}

export function LiveChip({ label = 'LIVE' }: { label?: string }) {
  return (
    <Chip tone="pink">
      <span className="live-dot inline-block h-2.5 w-2.5 rounded-full bg-pink" aria-hidden />
      {label}
    </Chip>
  );
}

export function DataSourceChip({ source }: { source: DataSource }) {
  if (source === 'live') return <Chip tone="lime"><span className="live-dot inline-block h-2 w-2 rounded-full bg-lime" aria-hidden />Live · Snowflake</Chip>;
  if (source === 'pending') return <Chip tone="amber"><span className="live-dot inline-block h-2 w-2 rounded-full bg-amber" aria-hidden />Connecting...</Chip>;
  return <Chip tone="muted">Offline</Chip>;
}

export function KeyHint({ k }: { k: string }) {
  return <kbd className="ml-2 rounded border border-current/50 px-1.5 py-px font-display text-xs opacity-80">{k}</kbd>;
}

export function Button({ variant = 'primary', children, onClick, hint, autoFocus, type = 'button' }: {
  variant?: 'primary' | 'secondary'; children: ReactNode; onClick?: () => void; hint?: string; autoFocus?: boolean; type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      autoFocus={autoFocus}
      onClick={onClick}
      className={cx(
        'skew-panel cursor-pointer px-8 py-3 font-display text-xl font-bold uppercase tracking-wider transition-transform duration-150 hover:scale-105 active:scale-95',
        variant === 'primary' ? 'glow-pink bg-pink text-navy' : 'border-2 border-cyan bg-navy/60 text-cyan',
      )}
    >
      <span className="inline-flex items-center">{children}{hint && <KeyHint k={hint} />}</span>
    </button>
  );
}

export function Panel({ children, className, tone }: { children: ReactNode; className?: string; tone?: 'cyan' | 'pink' | 'lime' }) {
  return (
    <div className={cx('relative rounded-sm border bg-navy-2/85 p-5 backdrop-blur', tone === 'pink' ? 'border-pink/60' : tone === 'lime' ? 'border-lime/60' : 'border-cyan/30', className)}>
      {children}
    </div>
  );
}

/** Synthwave backdrop: horizon glow + perspective grid floor. */
export function ArenaBackdrop({ children }: { children?: ReactNode }) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-navy">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_45%,rgb(255_46_136/.28),transparent_55%),radial-gradient(ellipse_at_50%_100%,rgb(34_229_255/.18),transparent_60%)]" />
      <div className="absolute inset-x-0 top-[45%] h-px bg-pink/70 shadow-[0_0_30px_6px_rgb(255_46_136/.5)]" />
      <div className="absolute inset-x-0 bottom-0 h-[55%] overflow-hidden"><div className="grid-floor" style={{ top: 0, height: '100%' }} /></div>
      <div className="relative z-10 h-full">{children}</div>
    </div>
  );
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms == null) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** Global key handler, ignored while typing in inputs. */
export function useHotkeys(map: Record<string, () => void>, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && e.key !== 'Escape') return;
      const fn = ref.current[e.key] ?? ref.current[e.key.toLowerCase()];
      if (fn) { e.preventDefault(); fn(); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [enabled]);
}
