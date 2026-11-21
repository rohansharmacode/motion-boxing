import { useRef, useState, type KeyboardEvent } from 'react';
import type { SportId } from '../types';
import { ArenaBackdrop, Button, Chip, LiveChip, cx } from '../components/ui';
import { Logo } from '../components/art';

export interface StartScreenProps {
  defaultName?: string;
  /** Shows the "Mock data: no API connected" footer chip. */
  mockData?: boolean;
  onStart: (name: string, sport: SportId) => void;
  onLeaderboard: () => void;
}

const SPORTS: { id: SportId; name: string; sub: string; enabled: boolean; icon: string }[] = [
  { id: 'boxing', name: 'Boxing', sub: 'Jab, cross, hook, uppercut', enabled: true, icon: '🥊' },
  { id: 'keeper', name: 'Reflex Keeper', sub: 'Goalkeeper reaction saves', enabled: false, icon: '🧤' },
  { id: 'bow', name: 'Aero Bow', sub: 'Draw, aim, release', enabled: false, icon: '🎯' },
];

export function StartScreen({ defaultName = '', mockData = true, onStart, onLeaderboard }: StartScreenProps) {
  const [name, setName] = useState(defaultName);
  const [sport, setSport] = useState<SportId>('boxing');
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  const onRadioKey = (e: KeyboardEvent, i: number) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = (i + dir + SPORTS.length) % SPORTS.length;
    refs.current[next]?.focus();
    if (SPORTS[next].enabled) setSport(SPORTS[next].id);
  };

  const start = () => onStart(name.trim() || 'PLAYER', sport);

  return (
    <ArenaBackdrop>
      <form className="screen-in mx-auto flex h-full max-w-5xl flex-col items-center justify-center gap-8 px-8" onSubmit={(e) => { e.preventDefault(); start(); }}>
        <div className="flex flex-col items-center gap-4 text-center">
          <LiveChip label="LIVE · 2026" />
          <Logo />
          <p className="text-2xl text-white/90">No controller. Just you, a webcam and Snowflake.</p>
        </div>

        <label className="flex w-full max-w-md flex-col gap-2">
          <span className="font-display text-sm uppercase tracking-widest text-muted">Fighter name</span>
          <input
            autoFocus
            maxLength={20}
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            placeholder="ENTER NAME"
            className="skew-panel border-2 border-cyan/70 bg-navy-2/90 px-5 py-3 font-display text-2xl font-bold tracking-wider text-white placeholder:text-muted/70 focus:border-cyan focus:outline-none"
          />
        </label>

        <div role="radiogroup" aria-label="Choose a sport" className="grid w-full grid-cols-3 gap-5">
          {SPORTS.map((s, i) => {
            const selected = sport === s.id;
            return (
              <div
                key={s.id}
                ref={(el) => { refs.current[i] = el; }}
                role="radio"
                aria-checked={selected}
                aria-disabled={!s.enabled}
                tabIndex={selected ? 0 : -1}
                onKeyDown={(e) => onRadioKey(e, i)}
                onClick={() => s.enabled && setSport(s.id)}
                className={cx(
                  'skew-panel relative cursor-pointer border-2 px-6 py-5 transition-all duration-200',
                  selected ? 'glow-cyan border-cyan bg-navy-3' : 'border-navy-3 bg-navy-2/80',
                  !s.enabled && 'cursor-not-allowed opacity-55',
                )}
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-4xl" aria-hidden>{s.icon}</span>
                    {s.enabled ? <Chip tone="lime">Featured</Chip> : <Chip tone="muted">Coming soon</Chip>}
                  </div>
                  <span className="font-display text-2xl font-bold uppercase">{s.name}</span>
                  <span className="text-lg text-muted">{s.sub}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-8">
          <Button type="submit" hint="Enter">Enter the ring</Button>
          <button type="button" onClick={onLeaderboard} className="font-display text-lg font-bold uppercase tracking-widest text-cyan underline-offset-4 hover:underline">
            Leaderboard <span className="opacity-70">(L)</span>
          </button>
        </div>
      </form>
      {mockData && <div className="absolute bottom-5 left-1/2 -translate-x-1/2"><Chip tone="amber">Mock data: no API connected</Chip></div>}
    </ArenaBackdrop>
  );
}
