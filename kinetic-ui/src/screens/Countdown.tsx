import { useEffect, useState } from 'react';

export interface CountdownProps {
  /** Static value for gallery; omit to auto-run 3-2-1-FIGHT. */
  value?: 3 | 2 | 1 | 'FIGHT';
  onDone?: () => void;
  stepMs?: number;
}

const STEPS = [3, 2, 1, 'FIGHT'] as const;

export function Countdown({ value, onDone, stepMs = 800 }: CountdownProps) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (value !== undefined) return;
    if (i >= STEPS.length) { onDone?.(); return; }
    const t = setTimeout(() => setI((n) => n + 1), i === STEPS.length - 1 ? stepMs * 1.2 : stepMs);
    return () => clearTimeout(t);
  }, [i, value, stepMs, onDone]);
  const v = value ?? STEPS[Math.min(i, STEPS.length - 1)];
  const fight = v === 'FIGHT';
  return (
    <div className="grid h-full w-full place-items-center overflow-hidden bg-navy/85" role="status" aria-live="assertive">
      <span key={String(v)} className={`pop-in tnum font-display font-bold italic leading-none ${fight ? 'text-glow-pink text-[14rem] text-pink' : 'text-glow-cyan text-[18rem] text-cyan'}`}>
        {fight ? 'FIGHT!' : v}
      </span>
    </div>
  );
}
