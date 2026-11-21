import type { CoachCard, CoachStatus, DataSource, LeaderboardRow, Percentiles, Result, RoundStats } from '../types';
import { ArenaBackdrop, Button, Chip, CountUp, DataSourceChip, Panel, cx, useHotkeys } from '../components/ui';
import { CoachPanel } from './CoachPanel';

export interface PostMatchScreenProps {
  result: Result;
  score: number;
  stats: RoundStats;
  coachStatus: CoachStatus;
  coach?: CoachCard;
  coachLoadingLines: string[];
  leaderboard: LeaderboardRow[];
  /** The player's own row; shown below "..." when outside the top 10. */
  playerRow: LeaderboardRow;
  percentiles: Percentiles;
  dataSource: DataSource;
  onRematch: () => void;
  onHome: () => void;
  /** Disable global hotkeys (e.g. in the gallery). */
  hotkeys?: boolean;
}

const HEADLINE: Record<Result, { text: string; cls: string }> = {
  WIN: { text: 'VICTORY', cls: 'text-lime text-glow-lime' },
  KO_WIN: { text: 'K.O. VICTORY', cls: 'text-lime text-glow-lime' },
  LOSS: { text: 'DEFEAT', cls: 'text-pink text-glow-pink' },
  KO_LOSS: { text: 'KNOCKED OUT', cls: 'text-pink text-glow-pink' },
  DRAW: { text: 'DRAW', cls: 'text-amber' },
};

export function formLabel(score: number) {
  return score >= 85 ? 'Champion' : score >= 65 ? 'Pro' : 'Contender';
}

const PCT_LABEL: [keyof Percentiles, string][] = [
  ['punch_speed_mps', 'Punch speed'], ['reaction_ms', 'Reaction'], ['accuracy_pct', 'Accuracy'],
  ['guard_pct', 'Guard'], ['symmetry_pct', 'Symmetry'], ['fatigue_drop_pct', 'Stamina'],
];
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

export function PostMatchScreen(p: PostMatchScreenProps) {
  useHotkeys({ r: p.onRematch, Escape: p.onHome }, p.hotkeys !== false);
  const h = HEADLINE[p.result];
  const inTop = p.leaderboard.slice(0, 10).some((r) => r.player_id === p.playerRow.player_id);
  const form = p.coach?.formScore;

  return (
    <ArenaBackdrop>
      <div className="screen-in mx-auto flex h-full max-w-[1800px] flex-col gap-3 overflow-y-auto px-8 py-5">
        <header className="flex items-end justify-between">
          <div>
            <h1 className={cx('pop-in font-display text-6xl font-bold italic leading-none 2xl:text-8xl', h.cls)}>{h.text}</h1>
            <div className="mt-1 font-display text-xl text-muted">Final score <CountUp value={p.score} durationMs={1600} className="ml-2 text-5xl font-bold text-white" /></div>
          </div>
          <div className="flex flex-col items-end gap-3">
            <DataSourceChip source={p.dataSource} />
            <div className="flex gap-4">
              <Button onClick={p.onRematch} hint="R">Rematch</Button>
              <Button variant="secondary" onClick={p.onHome} hint="Esc">Home</Button>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-5 gap-3">
          <Stat label="Punches" value={p.stats.punches} />
          <Stat label="Accuracy" value={p.stats.accuracyPct} unit="%" />
          <Stat label="Fastest" value={p.stats.fastestPunch} unit="SW/s" decimals={1} />
          <Stat label="Best reaction" value={p.stats.bestReactionMs} unit="ms" />
          <Stat label="Guard" value={p.stats.guardPct} unit="%" />
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[1.6fr_1fr] gap-4">
          <div className="flex flex-col gap-4">
            <CoachPanel status={p.coachStatus} coach={p.coach} loadingLines={p.coachLoadingLines} />
            <div className="flex flex-wrap gap-2">
              {PCT_LABEL.map(([k, label]) => (
                <Chip key={k} tone={p.percentiles[k] >= 70 ? 'lime' : p.percentiles[k] >= 40 ? 'cyan' : 'muted'}>
                  {label}: <span className="tnum">{ord(p.percentiles[k])}</span> percentile
                </Chip>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <Panel>
              <div className="mb-2 flex justify-between font-display text-sm font-bold uppercase tracking-widest text-muted"><span>Form score</span><span>vs pro benchmarks</span></div>
              {form == null ? <div className="skeleton h-12" /> : (
                <div className="flex items-center gap-4">
                  <CountUp value={form} className="font-display text-5xl 2xl:text-7xl font-bold text-lime" />
                  <div className="flex-1">
                    <div className="h-4 overflow-hidden rounded-sm bg-navy-3"><div className="h-full bg-gradient-to-r from-cyan to-lime transition-[width] duration-1000" style={{ width: `${form}%` }} /></div>
                    <div className="mt-1 font-display text-xl font-bold uppercase text-white">{formLabel(form)}</div>
                  </div>
                </div>
              )}
            </Panel>
            <Panel className="flex-1 !py-3">
              <div className="mb-1 font-display text-sm font-bold uppercase tracking-widest text-muted">Top 10</div>
              <MiniBoard rows={p.leaderboard.slice(0, 10)} me={p.playerRow} inTop={inTop} />
            </Panel>
          </div>
        </div>

      </div>
    </ArenaBackdrop>
  );
}

function Stat({ label, value, unit, decimals = 0 }: { label: string; value: number; unit?: string; decimals?: number }) {
  return (
    <div className="skew-panel border border-cyan/30 bg-navy-2/85 px-5 py-2">
      <div>
        <div className="font-display text-sm font-bold uppercase tracking-widest text-muted">{label}</div>
        <div className="font-display text-3xl font-bold 2xl:text-5xl"><CountUp value={value} decimals={decimals} />{unit && <span className="ml-1 text-lg text-muted">{unit}</span>}</div>
      </div>
    </div>
  );
}

function MiniBoard({ rows, me, inTop }: { rows: LeaderboardRow[]; me: LeaderboardRow; inTop: boolean }) {
  const Row = ({ r }: { r: LeaderboardRow }) => {
    const mine = r.player_id === me.player_id;
    return (
      <li className={cx('flex items-center gap-3 rounded-sm px-2 text-base leading-[1.3rem] 2xl:py-0.5 2xl:text-xl 2xl:leading-8', mine && 'glow-cyan bg-cyan/15 font-bold text-cyan')}>
        <span className="tnum w-8 font-display text-muted">{r.rank}</span>
        <span className="flex-1 truncate font-display">{r.name}{mine && ' (YOU)'}</span>
        <span className="tnum font-display">{r.score.toLocaleString('en-US')}</span>
      </li>
    );
  };
  return (
    <ol className="flex flex-col gap-0.5">
      {rows.map((r) => <Row key={r.player_id} r={r} />)}
      {!inTop && <><li className="px-2 text-muted" aria-hidden>...</li><Row r={me} /></>}
    </ol>
  );
}
