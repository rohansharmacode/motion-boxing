// DEV ONLY: component gallery. `npm run dev`, then open http://localhost:5173/src/ui/demo.html
// Every component runs on inline mock data (Leaderboard uses getLeaderboard, which falls back to mock).

import './demo.css';
import type { CoachCard, LeaderboardEntry, RoundResult, RoundStats, SessionEndResponse } from '../api/types';
import { BoxingHUD, CalibrationOverlay, PostMatchScreen, startLeaderboard } from './index';
import type { CalibrationWarning, GameContext } from './index';
import { el } from './dom';

type Mode = 'menu' | 'calibration' | 'hud' | 'post' | 'leaderboard';

const ui = document.getElementById('ui')!;
const bar = document.getElementById('demo-bar')!;
const PLAYER = { id: 'p_demo_naman', name: 'NAMAN' };

let cleanup: (() => void) | null = null;
let mode: Mode = 'menu';

function teardown() {
  cleanup?.();
  cleanup = null;
  ui.replaceChildren();
}

function button(label: string, onClick: () => void, cls = '') {
  const b = el('button', { type: 'button', class: cls }, label);
  b.addEventListener('click', onClick);
  return b;
}

function renderBar(extra: HTMLElement[] = []) {
  const main: [Mode, string, () => void][] = [
    ['calibration', 'Calibration', showCalibrationDemo],
    ['hud', 'HUD', showHudDemo],
    ['post', 'Post-match', () => showPostDemo('KO_WIN', 'resolve')],
    ['leaderboard', 'Leaderboard', showLeaderboardDemo],
  ];
  bar.replaceChildren(
    ...main.map(([m, label, fn]) => button(label, fn, m === mode ? 'on' : '')),
    ...(extra.length ? [el('span', { class: 'sep' }), ...extra] : []),
  );
}

function showMenu() {
  teardown();
  mode = 'menu';
  renderBar();
  ui.append(
    el(
      'section',
      { class: 'kr-screen' },
      el('div', { class: 'kr-calib-text', style: 'position:static' }, el('div', { class: 'kr-calib-title' }, 'UI demo'), el('div', { class: 'kr-calib-sub' }, 'Pick a component below.')),
    ),
  );
}

// ---------------- Calibration ----------------

function showCalibrationDemo() {
  teardown();
  mode = 'calibration';
  let cal = new CalibrationOverlay(ui, { sport: 'BOXING', playerName: PLAYER.name, onHeld: () => void cal.complete() });
  const warnings: (CalibrationWarning | null)[] = [null, 'too_dark', 'too_close', 'no_person'];
  let w = 0;
  let holding = false;
  let frames = 0;
  let frameTimer = 0;

  const holdBtn = button('Hold guard (2 s)', () => {
    holding = !holding;
    holdBtn.textContent = holding ? 'Drop guard' : 'Hold guard (2 s)';
    cal.setHolding(holding);
  }, 'sub');

  renderBar([
    button('Cycle warning', () => cal.setWarning(warnings[(w = (w + 1) % warnings.length)]), 'sub'),
    holdBtn,
    button('Frames 0→15', () => {
      clearInterval(frameTimer);
      frames = 0;
      frameTimer = window.setInterval(() => {
        cal.setProgress(++frames / 15);
        if (frames >= 15) clearInterval(frameTimer);
      }, 2000 / 15);
    }, 'sub'),
    button('Complete', () => void cal.complete(), 'sub'),
    button('Reset', () => {
      clearInterval(frameTimer);
      cal.destroy();
      holding = false;
      holdBtn.textContent = 'Hold guard (2 s)';
      cal = new CalibrationOverlay(ui, { sport: 'BOXING', playerName: PLAYER.name, onHeld: () => void cal.complete() });
    }, 'sub'),
  ]);
  cleanup = () => {
    clearInterval(frameTimer);
    cal.destroy();
  };
}

// ---------------- HUD ----------------

function showHudDemo() {
  teardown();
  mode = 'hud';
  const hud = new BoxingHUD(ui, { playerName: PLAYER.name, opponentName: 'Unit-07' });
  const TYPES = ['JAB', 'CROSS', 'HOOK', 'UPPERCUT'];
  let round = 1;
  let me = 100;
  let foe = 100;
  let guard = 80;
  let start = performance.now();
  let nextPunch = start + 600;
  let nextAttack = start + 1800;
  let pausedUntil = 0;
  let raf = 0;

  const reset = (now: number) => {
    me = 100;
    foe = 100;
    start = now;
    nextPunch = now + 600;
    nextAttack = now + 1800;
  };

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (now < pausedUntil) return;
    const left = 60000 - (now - start);
    guard = Math.max(5, Math.min(100, guard + (Math.random() - 0.48) * 3));

    if (now >= nextPunch) {
      const landed = Math.random() < 0.75;
      const speed = 1.4 + Math.random() * 3.6;
      hud.punch({ type: TYPES[Math.floor(Math.random() * TYPES.length)], speed, landed });
      if (landed) foe = Math.max(0, foe - (2 + speed * 1.6));
      nextPunch = now + 350 + Math.random() * 700;
    }
    if (now >= nextAttack) {
      const r = Math.random();
      if (r < 0.35) hud.pop('BLOCK');
      else if (r < 0.6) hud.pop('SLIP');
      else {
        me = Math.max(0, me - (6 + Math.random() * 8));
        hud.playerHit();
        hud.pop('HIT');
      }
      nextAttack = now + 1400 + Math.random() * 1500;
    }

    // Called every frame on purpose: the HUD only touches the DOM when values change.
    hud.update({ playerHp: me, opponentHp: foe, timeLeftMs: Math.max(0, left), round, guardPct: guard });

    if (foe <= 0 || me <= 0 || left <= 0) {
      hud.pop(foe <= 0 || me <= 0 ? 'KO' : 'Time!');
      pausedUntil = now + 2500;
      round = round % 3 + 1;
      reset(now + 2500);
    }
  };
  raf = requestAnimationFrame(loop);

  renderBar([
    button('BLOCK', () => hud.pop('BLOCK'), 'sub'),
    button('SLIP', () => hud.pop('SLIP'), 'sub'),
    button('HIT', () => hud.pop('HIT'), 'sub'),
    button('KO', () => hud.pop('KO'), 'sub'),
    button('Counter!', () => hud.pop('Counter!'), 'sub'),
    button('Low HP', () => {
      me = 18;
      foe = 12;
    }, 'sub'),
    button('Last 10 s', () => (start = performance.now() - 50000), 'sub'),
  ]);
  cleanup = () => {
    cancelAnimationFrame(raf);
    hud.destroy();
  };
}

// ---------------- Post-match ----------------

const MOCK_STATS: RoundStats = {
  punches: 64,
  landed: 47,
  byType: { JAB: 28, CROSS: 19, HOOK: 11, UPPERCUT: 6 },
  avgSpeed: 2.7,
  maxSpeed: 4.6,
  blocks: 9,
  dodges: 6,
  avgReactionMs: 412,
  leftRightRatio: 1.38,
  bestCombo: 7,
};

const MOCK_COACH: CoachCard = {
  headline: 'Fast hands, lazy guard: your right dropped after every cross.',
  tips: [
    'Bring your rear glove back to your cheek before the next punch; you were open for 0.6 s after crosses.',
    'Your left hand threw 58% of punches. Double up the cross to balance the pressure.',
    'Reaction slowed by 120 ms in the last 15 s. Breathe out on every punch to stay loose.',
  ],
  drill: { name: 'Jab-cross-slip ladder', description: '3 × 30 s: jab, cross, slip left, reset guard. Add one punch each set.' },
  badge: { name: 'Speed demon', description: 'Peak hand speed over 4.5 SW/s.' },
};

function mockLeaderboard(score: number): LeaderboardEntry[] {
  const names = ['VOLTAGE', 'AYA_K', 'MO.PUNCH', 'LINDQVIST', 'NEON RIO', 'J. OKAFOR', 'GHOSTJAB', 'PRIYA', 'TOMASZ', 'KAI', 'ZEE', 'BEN'];
  const rows = names.map((n, i) => ({ player_id: `p_${i}`, display_name: n, score: 3200 - i * 210 + (i % 3) * 37, max_speed: +(5.1 - i * 0.17).toFixed(2) }));
  rows.push({ player_id: PLAYER.id, display_name: PLAYER.name, score, max_speed: MOCK_STATS.maxSpeed });
  return rows
    .sort((a, b) => b.score - a.score)
    .map((r, i): LeaderboardEntry => ({ ...r, rank: i + 1, sport: 'BOXING' }));
}

function showPostDemo(result: RoundResult, outcome: 'resolve' | 'reject' | 'live', score = 2140) {
  teardown();
  mode = 'post';
  const data = new Promise<SessionEndResponse>((resolve, reject) =>
    setTimeout(() => {
      if (outcome === 'reject') reject(new Error('demo: network down'));
      else resolve({ coach: MOCK_COACH, leaderboard: mockLeaderboard(score), form_score: 74, source: outcome === 'live' ? 'live' : 'mock' });
    }, 1800),
  );
  const ctx: GameContext = { host: ui, signal: new AbortController().signal, exit: showMenu };
  const screen = new PostMatchScreen(ui, {
    ctx,
    result,
    score,
    stats: MOCK_STATS,
    playerId: PLAYER.id,
    data,
    guardPct: 68,
    onRematch: () => showHudDemo(),
  });
  renderBar([
    button('KO win · mock', () => showPostDemo('KO_WIN', 'resolve'), 'sub'),
    button('Win · live chip', () => showPostDemo('WIN', 'live', 2890), 'sub'),
    button('Loss · off top 10', () => showPostDemo('LOSS', 'resolve', 640), 'sub'),
    button('Offline (reject)', () => showPostDemo('KO_LOSS', 'reject'), 'sub'),
  ]);
  cleanup = () => screen.destroy();
}

// ---------------- Leaderboard ----------------

function showLeaderboardDemo() {
  teardown();
  mode = 'leaderboard';
  renderBar();
  let session: { dispose(): void } | null = null;
  const ctx: GameContext = {
    host: ui,
    signal: new AbortController().signal,
    exit: () => {
      session?.dispose();
      // Deep link: demo.html?view=calibration|hud|post|post-offline|leaderboard
const VIEWS: Record<string, () => void> = {
  calibration: showCalibrationDemo,
  hud: showHudDemo,
  post: () => showPostDemo('KO_WIN', 'resolve'),
  'post-offline': () => showPostDemo('KO_LOSS', 'reject'),
  leaderboard: showLeaderboardDemo,
};
(VIEWS[new URLSearchParams(location.search).get('view') ?? ''] ?? showMenu)();
    },
  };
  session = startLeaderboard(ctx);
  cleanup = () => session?.dispose();
}

// Deep link: demo.html?view=calibration|hud|post|post-offline|leaderboard
const VIEWS: Record<string, () => void> = {
  calibration: showCalibrationDemo,
  hud: showHudDemo,
  post: () => showPostDemo('KO_WIN', 'resolve'),
  'post-offline': () => showPostDemo('KO_LOSS', 'reject'),
  leaderboard: showLeaderboardDemo,
};
(VIEWS[new URLSearchParams(location.search).get('view') ?? ''] ?? showMenu)();
