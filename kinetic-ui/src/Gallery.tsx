import { useMemo, type ReactNode } from 'react';
import type { CalibrationState, HudEvent, Result } from './types';
import * as mock from './mocks';
import { createHudStore } from './hudStore';
import { StartScreen } from './screens/StartScreen';
import { CalibrationOverlay } from './screens/CalibrationOverlay';
import { Countdown } from './screens/Countdown';
import { RoundHud } from './screens/RoundHud';
import { PostMatchScreen } from './screens/PostMatchScreen';
import { LeaderboardScreen } from './screens/LeaderboardScreen';

const noop = () => {};

/** Each frame renders a screen at 1280x720 and scales it down. */
function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="font-display text-sm font-bold uppercase tracking-widest text-muted">{title}</figcaption>
      <div className="relative aspect-video w-full overflow-hidden rounded border border-navy-3 [container-type:inline-size]">
        <div className="absolute left-0 top-0 h-[720px] w-[1280px] origin-top-left" style={{ transform: 'scale(calc(100cqw / 1280px))' }}>{children}</div>
      </div>
    </figure>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-3xl font-bold uppercase text-cyan">{title}</h2>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 2xl:grid-cols-3">{children}</div>
    </section>
  );
}

function HudFrame({ event, hp = [72, 41], combo = 0, time = 47_000, telegraph = false }: { event?: HudEvent; hp?: [number, number]; combo?: number; time?: number; telegraph?: boolean }) {
  const store = useMemo(() => createHudStore(
    { playerHp: hp[0], opponentHp: hp[1], timeLeftMs: time, round: 1, combo, guardPct: 64 },
    { lastPunch: { type: 'CROSS', speed: 3.8, landed: true }, event: event ?? null, eventSeq: event ? 1 : 0, telegraphAt: telegraph ? 1 : null },
  ), [event, hp, combo, time, telegraph]);
  return <RoundHud store={store} playerName="NOVA" />;
}

const CAL: CalibrationState[] = ['searching', 'too_close', 'too_far', 'off_centre', 'low_light', 'holding', 'locked'];
const RESULTS: Result[] = ['WIN', 'KO_WIN', 'LOSS', 'KO_LOSS', 'DRAW'];

export function Gallery() {
  const post = (over: Partial<Parameters<typeof PostMatchScreen>[0]>) => (
    <PostMatchScreen result="WIN" score={mock.mockFinalScore} stats={mock.mockStats} coachStatus="ready" coach={mock.mockCoach}
      coachLoadingLines={mock.mockCoachLoadingLines} leaderboard={mock.mockLeaderboard} playerRow={mock.mockPlayerRowOutside}
      percentiles={mock.mockPercentiles} dataSource="live" onRematch={noop} onHome={noop} hotkeys={false} {...over} />
  );
  return (
    <div className="min-h-full bg-navy px-8 py-8">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="font-display text-5xl font-bold uppercase italic"><span className="text-cyan">Kinetic Ring</span> <span className="text-pink">Gallery</span></h1>
        <a href="#/" className="font-display text-lg font-bold uppercase tracking-widest text-cyan underline">Play the flow</a>
      </header>
      <div className="flex flex-col gap-12">
        <Section title="1 · Start"><Frame title="Start screen"><StartScreen defaultName="NOVA" onStart={noop} onLeaderboard={noop} /></Frame></Section>
        <Section title="2 · Calibration">
          {CAL.map((s) => <Frame key={s} title={`Calibration · ${s}`}><CalibrationOverlay state={s} holdProgress={0.6} /></Frame>)}
        </Section>
        <Section title="3 · Countdown">
          {([3, 2, 1, 'FIGHT'] as const).map((v) => <Frame key={v} title={`Countdown · ${v}`}><Countdown value={v} /></Frame>)}
        </Section>
        <Section title="4 · In-round HUD">
          <Frame title="HUD · combo x4"><HudFrame combo={4} /></Frame>
          {(['BLOCK', 'SLIP', 'HIT', 'COUNTER'] as const).map((e) => <Frame key={e} title={`HUD · ${e}`}><HudFrame event={e} /></Frame>)}
          <Frame title="HUD · telegraph + under 10 s"><HudFrame telegraph time={8_000} hp={[22, 30]} /></Frame>
          <Frame title="HUD · K.O."><HudFrame event="KO" hp={[58, 0]} /></Frame>
        </Section>
        <Section title="5 · Post-match">
          {RESULTS.map((r) => <Frame key={r} title={`Result · ${r}`}>{post({ result: r })}</Frame>)}
          <Frame title="Coach · loading (connecting)">{post({ coachStatus: 'loading', coach: undefined, dataSource: 'pending' })}</Frame>
          <Frame title="Coach · offline fallback">{post({ coach: mock.mockCoachFallback, dataSource: 'offline' })}</Frame>
          <Frame title="Player in top 10">{post({ leaderboard: mock.mockLeaderboardWithPlayer, playerRow: mock.mockLeaderboardWithPlayer[3] })}</Frame>
        </Section>
        <Section title="6 · Leaderboard">
          <Frame title="Leaderboard · player in top 10"><LeaderboardScreen rows={mock.mockLeaderboardWithPlayer} playerId={mock.MOCK_PLAYER_ID} updatedAt={Date.now() - 3000} dataSource="live" globalStats={mock.mockGlobalStats} /></Frame>
          <Frame title="Leaderboard · player not in top 10"><LeaderboardScreen rows={mock.mockLeaderboard} playerId={mock.MOCK_PLAYER_ID} updatedAt={Date.now() - 3000} dataSource="offline" globalStats={mock.mockGlobalStats} /></Frame>
        </Section>
      </div>
    </div>
  );
}
