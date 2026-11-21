import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DataSource, LeaderboardRow } from '../types';
import { ArenaBackdrop, DataSourceChip, cx, useHotkeys, useInterval } from '../components/ui';
import { Logo } from '../components/art';

export interface LeaderboardScreenProps {
  rows: LeaderboardRow[];
  /** Highlight this player's row when present. */
  playerId?: string;
  /** Timestamp (ms) of the last refresh. */
  updatedAt: number;
  dataSource: DataSource;
  globalStats: { totalPlayers: number; totalPunches: number; fastestPunchEver: number };
  onHome?: () => void;
}

const MEDAL = ['text-gold border-gold', 'text-silver border-silver', 'text-bronze border-bronze'];

export function LeaderboardScreen({ rows, playerId, updatedAt, dataSource, globalStats, onHome }: LeaderboardScreenProps) {
  useHotkeys({ Escape: () => onHome?.() }, !!onHome);
  const [now, setNow] = useState(Date.now());
  useInterval(() => setNow(Date.now()), 1000);
  const ago = Math.max(0, Math.round((now - updatedAt) / 1000));

  // FLIP row reordering + "NEW" flash for changed rows
  const els = useRef(new Map<string, HTMLElement>());
  const prevTop = useRef(new Map<string, number>());
  const prevSig = useRef(new Map<string, string>());
  const [changed, setChanged] = useState<Set<string>>(new Set());
  useLayoutEffect(() => {
    const ch = new Set<string>();
    rows.forEach((r) => {
      const el = els.current.get(r.player_id);
      const sig = `${r.rank}|${r.score}`;
      const old = prevSig.current.get(r.player_id);
      if (old !== undefined && old !== sig) ch.add(r.player_id);
      prevSig.current.set(r.player_id, sig);
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const before = prevTop.current.get(r.player_id);
      if (before !== undefined && before !== top && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], { duration: 600, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
      prevTop.current.set(r.player_id, top);
    });
    if (ch.size) setChanged(ch);
  }, [rows]);
  useEffect(() => { if (!changed.size) return; const t = setTimeout(() => setChanged(new Set()), 1600); return () => clearTimeout(t); }, [changed]);

  const ticker = `TOTAL PLAYERS ${globalStats.totalPlayers.toLocaleString('en-US')}   ◆   TOTAL PUNCHES THROWN ${globalStats.totalPunches.toLocaleString('en-US')}   ◆   FASTEST PUNCH EVER ${globalStats.fastestPunchEver.toFixed(1)} SW/s   ◆   `;

  return (
    <ArenaBackdrop>
      <div className="screen-in flex h-full flex-col">
        <header className="flex items-center justify-between px-12 pt-8">
          <div className="flex items-center gap-6"><Logo size="sm" /><span className="font-display text-3xl font-bold uppercase tracking-widest">Top 10</span></div>
          <div className="flex items-center gap-4"><span className="tnum font-display text-lg text-muted">Updated {ago} s ago</span><DataSourceChip source={dataSource} /></div>
        </header>
        <div className="mx-auto w-full max-w-6xl flex-1 px-12 py-6">
          <div className="grid grid-cols-[6rem_1fr_10rem_10rem_10rem] px-6 pb-2 font-display text-sm font-bold uppercase tracking-widest text-muted">
            <span>Rank</span><span>Name</span><span className="text-right">Score</span><span className="text-right">Fastest</span><span className="text-right">Reaction</span>
          </div>
          <ol className="flex flex-col gap-2">
            {rows.slice(0, 10).map((r) => {
              const mine = r.player_id === playerId;
              return (
                <li key={r.player_id} ref={(el) => { if (el) els.current.set(r.player_id, el); else els.current.delete(r.player_id); }}
                  className={cx('skew-panel relative border-l-4 bg-navy-2/90', r.rank <= 3 ? MEDAL[r.rank - 1] : 'border-navy-3', mine && 'glow-cyan border-cyan', changed.has(r.player_id) && 'new-flash')}>
                  <div className="grid grid-cols-[6rem_1fr_10rem_10rem_10rem] items-center px-6 py-2.5 font-display text-2xl">
                    <span className={cx('tnum text-3xl font-bold', r.rank <= 3 ? MEDAL[r.rank - 1].split(' ')[0] : 'text-muted')}>{String(r.rank).padStart(2, '0')}</span>
                    <span className="flex items-center gap-3 font-bold">{r.name}{mine && <span className="text-cyan">(YOU)</span>}
                      {changed.has(r.player_id) && <span className="rounded bg-lime px-2 text-sm text-navy">NEW</span>}</span>
                    <span className="tnum text-right font-bold">{r.score.toLocaleString('en-US')}</span>
                    <span className="tnum text-right text-cyan">{r.fastest_punch.toFixed(1)}<span className="ml-1 text-base text-muted">SW/s</span></span>
                    <span className="tnum text-right text-lime">{r.best_reaction_ms}<span className="ml-1 text-base text-muted">ms</span></span>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="overflow-hidden border-t-2 border-pink bg-navy/90 py-3">
          <div className="ticker flex w-max whitespace-nowrap font-display text-xl font-bold tracking-widest text-white"><span>{ticker}</span><span>{ticker}</span></div>
        </div>
      </div>
    </ArenaBackdrop>
  );
}
