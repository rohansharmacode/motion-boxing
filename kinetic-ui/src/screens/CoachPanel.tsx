import { useEffect, useState } from 'react';
import type { CoachCard, CoachStatus } from '../types';
import { Chip, Panel, cx, useInterval } from '../components/ui';
import { BadgeIcon } from '../components/art';

export interface CoachPanelProps {
  status: CoachStatus;
  coach?: CoachCard;
  loadingLines: string[];
}

export function CoachPanel({ status, coach, loadingLines }: CoachPanelProps) {
  return (
    <Panel tone="cyan" className="flex min-h-[19rem] flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-2xl font-bold uppercase tracking-wider">AI Coach</h2>
        <div className="flex gap-2">
          {coach?.fallback && status === 'ready' && <Chip tone="muted">Offline coach</Chip>}
          <Chip tone="cyan">Powered by Snowflake Cortex</Chip>
        </div>
      </div>
      {status === 'loading' || !coach ? <CoachLoading lines={loadingLines} /> : <CoachBody coach={coach} />}
    </Panel>
  );
}

function CoachLoading({ lines }: { lines: string[] }) {
  const [i, setI] = useState(0);
  useInterval(() => setI((n) => (n + 1) % lines.length), 1400);
  return (
    <div className="flex flex-1 flex-col gap-4" role="status" aria-live="polite">
      <div className="flex items-center gap-4">
        <div className="flex h-10 items-end gap-1" aria-hidden>
          {[0, 1, 2, 3, 4, 5].map((b) => <span key={b} className="eq-bar block w-2 rounded-sm bg-cyan" style={{ height: '100%', animationDelay: `${b * 110}ms` }} />)}
        </div>
        <div>
          <div className="font-display text-xl font-bold">Analysing your form...</div>
          <div key={i} className="rise text-lg text-muted">{lines[i]}</div>
        </div>
      </div>
      {[90, 75, 82, 60, 70].map((w, k) => <div key={k} className="skeleton h-5" style={{ width: `${w}%` }} />)}
    </div>
  );
}

function CoachBody({ coach }: { coach: CoachCard }) {
  const [shown, setShown] = useState(false);
  useEffect(() => setShown(true), []);
  const d = (n: number) => ({ animationDelay: `${n * 110}ms` });
  return (
    <div className={cx('flex flex-col gap-4', !shown && 'opacity-0')}>
      <p className="rise font-display text-xl font-bold text-white 2xl:text-3xl" style={d(0)}>{coach.headline}</p>
      <ol className="flex flex-col gap-2">
        {coach.tips.map((t, k) => (
          <li key={k} className="rise flex gap-3 text-base 2xl:text-xl" style={d(k + 1)}>
            <span className="tnum font-display text-xl font-bold text-cyan">{k + 1}</span><span>{t}</span>
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-3">
        <div className="rise rounded border border-navy-3 bg-navy/60 p-3" style={d(4)}>
          <div className="font-display text-xs font-bold uppercase tracking-widest text-muted">Your drill</div>
          <div className="font-display text-lg font-bold text-lime">{coach.drill.name}</div>
          <div className="text-base text-white/85">{coach.drill.description}</div>
        </div>
        <div className="rise flex items-center gap-3 rounded border border-lime/50 bg-navy/60 p-3" style={d(5)}>
          <BadgeIcon className="h-12 w-12 shrink-0" />
          <div>
            <div className="font-display text-xs font-bold uppercase tracking-widest text-muted">Badge earned</div>
            <div className="font-display text-lg font-bold text-lime">{coach.badge.name}</div>
            <div className="text-base text-white/85">{coach.badge.description}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
