import { useEffect, useMemo, useState } from 'react';
import type { CalibrationState, CoachStatus, LeaderboardRow, Result } from './types';
import * as mock from './mocks';
import { createHudStore } from './hudStore';
import { useHotkeys, useInterval } from './components/ui';
import { StartScreen } from './screens/StartScreen';
import { CalibrationOverlay } from './screens/CalibrationOverlay';
import { Countdown } from './screens/Countdown';
import { RoundHud } from './screens/RoundHud';
import { DemoControls } from './screens/DemoControls';
import { PostMatchScreen } from './screens/PostMatchScreen';
import { LeaderboardScreen } from './screens/LeaderboardScreen';
import { Gallery } from './Gallery';

type Screen = 'start' | 'calibrate' | 'countdown' | 'round' | 'post' | 'leaderboard';

export default function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const on = () => setHash(location.hash); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  if (hash.startsWith('#/gallery')) return <Gallery />;
  return <GameFlow />;
}

/** Mock-driven game flow. Swap mock calls for the real engine / API. */
function GameFlow() {
  const [screen, setScreen] = useState<Screen>('start');
  const [name, setName] = useState(mock.MOCK_PLAYER_NAME);
  const [result, setResult] = useState<Result>('KO_WIN');

  return (
    <div className="h-full w-full" key={screen}>
      {screen === 'start' && (
        <StartScreenWithKeys onStart={(n) => { setName(n); setScreen('calibrate'); }} onLeaderboard={() => setScreen('leaderboard')} />
      )}
      {screen === 'calibrate' && <MockCalibration onLocked={() => setScreen('countdown')} />}
      {screen === 'countdown' && <Countdown onDone={() => setScreen('round')} />}
      {screen === 'round' && <MockRound name={name} onEnd={(r) => { setResult(r); setScreen('post'); }} />}
      {screen === 'post' && <MockPostMatch result={result} onRematch={() => setScreen('calibrate')} onHome={() => setScreen('start')} />}
      {screen === 'leaderboard' && <MockLeaderboard onHome={() => setScreen('start')} />}
    </div>
  );
}

function StartScreenWithKeys(props: { onStart: (n: string) => void; onLeaderboard: () => void }) {
  useHotkeys({ l: props.onLeaderboard });
  return <StartScreen defaultName="" mockData onStart={props.onStart} onLeaderboard={props.onLeaderboard} />;
}

const CAL_SEQ: [CalibrationState, number][] = [['searching', 1200], ['too_close', 1100], ['off_centre', 1100], ['holding', 2000], ['locked', 900]];
function MockCalibration({ onLocked }: { onLocked: () => void }) {
  const [i, setI] = useState(0);
  const [prog, setProg] = useState(0);
  const [state, dur] = CAL_SEQ[i];
  useEffect(() => {
    const t0 = performance.now();
    let raf = 0;
    if (state === 'holding') { const f = (t: number) => { setProg(Math.min(1, (t - t0) / dur)); if (t - t0 < dur) raf = requestAnimationFrame(f); }; raf = requestAnimationFrame(f); }
    const t = setTimeout(() => (i + 1 < CAL_SEQ.length ? setI(i + 1) : onLocked()), dur);
    return () => { clearTimeout(t); cancelAnimationFrame(raf); };
  }, [i, state, dur, onLocked]);
  useHotkeys({ Enter: onLocked });
  return <CalibrationOverlay state={state} holdProgress={prog} />;
}

function MockRound({ name, onEnd }: { name: string; onEnd: (r: Result) => void }) {
  const store = useMemo(() => createHudStore({ ...mock.mockHud, timeLeftMs: 60_000 }), []);
  useEffect(() => {
    let raf = 0, last = performance.now(), done = false;
    const f = (t: number) => {
      const s = store.get();
      store.update({ timeLeftMs: Math.max(0, s.timeLeftMs - (t - last)) });
      last = t;
      if (!done && s.timeLeftMs <= 0) { done = true; onEnd(s.playerHp > s.opponentHp ? 'WIN' : s.playerHp < s.opponentHp ? 'LOSS' : 'DRAW'); return; }
      if (!done && s.playerHp <= 0) { done = true; store.event('KO'); setTimeout(() => onEnd('KO_LOSS'), 1400); return; }
      raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [store, onEnd]);
  return (
    <div className="relative h-full w-full">
      <RoundHud store={store} playerName={name} />
      <DemoControls store={store} onKo={() => onEnd('KO_WIN')} />
      <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 font-display text-xs uppercase tracking-widest text-muted/70">Press D for demo controls</div>
    </div>
  );
}

function MockPostMatch({ result, onRematch, onHome }: { result: Result; onRematch: () => void; onHome: () => void }) {
  const [status, setStatus] = useState<CoachStatus>('loading');
  useEffect(() => { const t = setTimeout(() => setStatus('ready'), 3200); return () => clearTimeout(t); }, []);
  return (
    <PostMatchScreen
      result={result} score={mock.mockFinalScore} stats={mock.mockStats}
      coachStatus={status} coach={status === 'ready' ? mock.mockCoach : undefined} coachLoadingLines={mock.mockCoachLoadingLines}
      leaderboard={mock.mockLeaderboard} playerRow={mock.mockPlayerRowOutside} percentiles={mock.mockPercentiles}
      dataSource={status === 'ready' ? 'live' : 'pending'} onRematch={onRematch} onHome={onHome}
    />
  );
}

export function MockLeaderboard({ onHome }: { onHome?: () => void }) {
  const [rows, setRows] = useState<LeaderboardRow[]>(mock.mockLeaderboardWithPlayer);
  const [at, setAt] = useState(Date.now());
  useInterval(() => { setRows((r) => mock.shuffleLeaderboard(r)); setAt(Date.now()); }, 5000);
  return <LeaderboardScreen rows={rows} playerId={mock.MOCK_PLAYER_ID} updatedAt={at} dataSource="live" globalStats={mock.mockGlobalStats} onHome={onHome} />;
}
