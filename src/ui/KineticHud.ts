// Drop-in replacement for src/sports/boxing/hud.ts: implements the game's BoxingHud contract
// with the Kinetic Ring UI components, and reports each round to the backend.
//
// In src/main.ts:
//   import { createKineticHud } from './ui/KineticHud.ts'
//   const hud = createKineticHud(ui)          // instead of createBoxingHud(ui)

import { createBoxingLink } from '../api/boxingLink';
import type { BoxingLink } from '../api/boxingLink';
import { USE_MOCK } from '../api/client';
import type { CalibrationStatus, StartupErrorKind } from '../pose/types.ts';
import type { BoxingHud, Punch, PunchCounts, RoundResult } from '../sports/boxing/types.ts';
import { BoxingHUD } from './BoxingHUD';
import { CalibrationOverlay } from './CalibrationOverlay';
import { artImg, el } from './dom';
import { PostMatchScreen } from './PostMatchScreen';
import type { GameContext } from './shellTypes';
import './styles.css';
import './components.css';
import './kinetic.css';

/** Shown under the timer in keyboard mode, so nobody has to guess the keys. */
const KEYBOARD_HINT = 'Keyboard · J jab · K cross · H hook · U uppercut · Shift guard · ← → dodge';

const DRONE_NAME = 'HEX-7';
const ROUND_MS = 60_000;
const NAME_KEY = 'kr.lastName';

const ERROR_COPY: Record<StartupErrorKind, [string, string]> = {
  'camera-denied': ['Camera blocked', 'Allow the camera in the address bar, then try again. Or play with the keyboard.'],
  'camera-not-found': ['No camera found', 'Plug in a webcam, then try again.'],
  'camera-in-use': ['Camera is busy', 'Close video calls and other camera tabs, then try again.'],
  'camera-unsupported': ['Browser not supported', 'Use a recent Chrome, Edge, Firefox or Safari over https or localhost.'],
  'camera-other': ['Camera would not start', 'Reconnect it or restart the browser, then try again.'],
  'tracker-failed': ['Tracker did not load', 'The pose tracker downloads from the internet. Check the connection, then try again.'],
};

export interface KineticHudOptions {
  /** When running inside the shell: Home on the post-match screen calls ctx.exit(). */
  ctx?: GameContext;
  /** Home button without a shell. Default: reload the page (back to the start screen). */
  onHome?: () => void;
  /** Share an existing backend link; one is created otherwise. */
  link?: BoxingLink;
}

type Phase = 'start' | 'loading' | 'error' | 'calibrating' | 'fight' | 'ended';

export function createKineticHud(root: HTMLElement, opts: KineticHudOptions = {}): BoxingHud & { dispose(): void } {
  const layer = el('div', { class: 'kr-kinetic' });
  root.append(layer);

  let playerName = localStorage.getItem(NAME_KEY) ?? '';
  const link = opts.link ?? createBoxingLink({ displayName: playerName || 'Player' });

  let phase: Phase = 'start';
  let panel: HTMLElement | null = null;
  let calib: CalibrationOverlay | null = null;
  let hud: BoxingHUD | null = null;
  let post: PostMatchScreen | null = null;
  let keyboardMode = false;
  /** Online 1v1: the friend's name replaces the drone's on the health bar. */
  let opponentName: string | null = null;
  let combo = 0;
  let guardOn = false;
  let guardSamples = 0;
  let guardHits = 0;
  let endTimer = 0;
  const telegraph = el('div', { class: 'kr-telegraph', 'aria-hidden': 'true' });
  const debug = el('pre', { class: 'kr-debug', hidden: '' });
  layer.append(telegraph, debug);

  const clear = () => {
    clearTimeout(endTimer);
    panel?.remove();
    panel = null;
    calib?.destroy();
    calib = null;
    post?.destroy();
    post = null;
  };
  const showPanel = (node: HTMLElement) => {
    clear();
    hud?.destroy();
    hud = null;
    telegraph.classList.remove('kr-on');
    panel = node;
    layer.append(node);
  };
  const button = (label: string, cls: string, onClick: () => void) => {
    const b = el('button', { class: `kr-btn ${cls}`, type: 'button' }, label);
    b.addEventListener('click', onClick);
    return b;
  };

  const api: BoxingHud & { dispose(): void } = {
    showStart(onCamera, onKeyboard) {
      phase = 'start';
      const input = el('input', { class: 'kr-k-name', type: 'text', maxlength: '16', placeholder: 'YOUR NAME', 'aria-label': 'Player name', autocomplete: 'off', spellcheck: 'false' });
      input.value = playerName;
      const go = (fn: () => void) => () => {
        playerName = input.value.trim() || 'Player';
        localStorage.setItem(NAME_KEY, playerName);
        void link.setPlayer(playerName);
        fn();
      };
      const cam = button('Start camera', 'kr-btn-pink', go(onCamera));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') cam.click();
        e.stopPropagation(); // typing "d" must not trigger the game's keyboard-mode hotkey
      });
      showPanel(
        el(
          'section',
          { class: 'kr-screen kr-backdrop kr-k-start' },
          el(
            'div',
            { class: 'kr-k-col' },
            el('span', { class: 'kr-live' }, el('span', {}, 'Live · 2026')),
            el('h1', { class: 'kr-k-title' }, 'Kinetic ', el('span', {}, 'Ring')),
            el('p', { class: 'kr-k-sub' }, `No controller. Your webcam vs ${DRONE_NAME}.`),
            el('label', { class: 'kr-label' }, 'Player'),
            input,
            el('div', { class: 'kr-k-row' }, cam, button('Keyboard (D)', 'kr-btn-ghost', go(onKeyboard))),
            el('p', { class: 'kr-k-hint' }, 'Stand about 2 m back. Guard up to block, lean to slip.'),
            USE_MOCK ? el('span', { class: 'kr-chip' }, 'Mock data · no API') : null,
          ),
        ),
      );
      requestAnimationFrame(() => input.focus());
    },

    showLoading(text) {
      phase = 'loading';
      showPanel(
        el('section', { class: 'kr-screen kr-backdrop kr-k-start', role: 'status' },
          el('div', { class: 'kr-k-col' }, artImg('splash-loading.svg', 'kr-k-splash'), el('div', { class: 'kr-loading-bars' }, ...Array.from({ length: 5 }, () => el('i'))), el('p', { class: 'kr-k-sub' }, text))),
      );
    },

    showError(kind, onRetry, onKeyboard) {
      phase = 'error';
      const [title, help] = ERROR_COPY[kind];
      showPanel(
        el('section', { class: 'kr-screen kr-backdrop kr-k-start', role: 'alert' },
          el('div', { class: 'kr-k-col' }, el('h1', { class: 'kr-k-title kr-k-err' }, title), el('p', { class: 'kr-k-sub' }, help),
            el('div', { class: 'kr-k-row' }, button('Try again', 'kr-btn-pink', onRetry), button('Keyboard (D)', 'kr-btn-ghost', onKeyboard)))),
      );
    },

    showCalibration(progress: number, status: CalibrationStatus) {
      if (phase !== 'calibrating' || !calib) {
        clear();
        hud?.destroy();
        hud = null;
        phase = 'calibrating';
        calib = new CalibrationOverlay(layer, { sport: 'BOXING', playerName });
      }
      if (status === 'done') {
        const c = calib;
        calib = null;
        void c.complete();
        return;
      }
      calib.setWarning(
        status === 'no-pose' ? 'no_person'
        : status === 'too-close' ? 'too_close'
        : status === 'shoulders-hidden' ? 'shoulders_hidden'
        : status === 'hands-hidden' ? 'hands_hidden'
        : null,
      );
      calib.setProgress(status === 'holding' ? progress : 0);
    },

    showFight() {
      phase = 'fight';
      if (calib) {
        const c = calib;
        calib = null;
        void c.complete(); // let LOCKED IN play out over the fight
      }
      clearTimeout(endTimer);
      panel?.remove();
      panel = null;
      post?.destroy();
      post = null;
      hud?.destroy();
      hud = new BoxingHUD(layer, { playerName: playerName || 'Player', opponentName: opponentName ?? DRONE_NAME, roundMs: ROUND_MS });
      hud.element.classList.add('kr-big');
      hud.update({ playerHp: 100, opponentHp: 100, timeLeftMs: ROUND_MS, round: 1, combo: 0 });
      hud.setMode(keyboardMode ? KEYBOARD_HINT : null);
      combo = 0;
      guardSamples = 0;
      guardHits = 0;
    },

    setHp(player, drone) {
      hud?.update({ playerHp: player, opponentHp: drone });
    },

    setTimer(msLeft) {
      guardSamples++;
      if (guardOn) guardHits++;
      hud?.update({ timeLeftMs: msLeft, guardPct: Math.round((guardHits / guardSamples) * 100) });
    },

    setCounts(_counts: PunchCounts) {
      // Totals are shown on the post-match screen; the HUD shows combo and speed instead.
    },

    flashPunch(punch: Punch, landed: boolean, counter: boolean) {
      combo = landed ? combo + 1 : 0;
      hud?.punch({ type: punch.kind.toUpperCase(), speed: punch.peakVelocity, landed });
      hud?.update({ combo });
      if (counter && landed) hud?.pop('COUNTER!');
    },

    callout(text, tone) {
      const t = text.toUpperCase();
      if (t === 'BLOCKED') hud?.pop('BLOCK');
      else if (t === 'SLIPPED') hud?.pop('SLIP');
      else if (t === 'HIT') {
        combo = 0;
        hud?.update({ combo });
        hud?.playerHit();
        hud?.pop('HIT');
      } else if (t === 'COUNTER') hud?.banner('Counter window!', 'good');
      else hud?.banner(text, tone === 'bad' ? 'bad' : 'good');
    },

    setGuard(on) {
      guardOn = on;
    },

    setTelegraph(pattern) {
      telegraph.classList.toggle('kr-on', pattern !== null && phase === 'fight');
    },

    setKeyboardMode(on) {
      keyboardMode = on;
      hud?.setMode(on ? KEYBOARD_HINT : null);
    },

    showRoundEnd(result: RoundResult, onAgain, onHome) {
      if (phase === 'ended') return;
      phase = 'ended';
      telegraph.classList.remove('kr-on');
      const summary = link.endRound(result);
      if (result.outcome === 'ko-win') hud?.pop('KO');
      else hud?.banner(result.outcome === 'ko-loss' ? 'Knocked down' : 'Time!', result.outcome === 'ko-loss' ? 'bad' : 'good');

      endTimer = window.setTimeout(() => {
        hud?.destroy();
        hud = null;
        post = new PostMatchScreen(layer, {
          ctx: opts.ctx,
          result: summary.result,
          score: summary.score,
          stats: summary.stats,
          playerId: summary.playerId,
          data: summary.data,
          guardPct: summary.stats.guardPct ?? null,
          // main.ts also binds R to again(); only the first rematch of a round counts.
          onRematch: () => {
            if (phase === 'ended') onAgain();
          },
          onHome: onHome ?? opts.onHome ?? (opts.ctx ? undefined : () => location.reload()),
        });
      }, 1500);
    },

    setDebug(values) {
      if (debug.hidden) return;
      debug.textContent = Object.entries(values)
        .map(([k, v]) => `${k.padEnd(14)} ${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`)
        .join('\n');
    },

    toggleDebug() {
      debug.hidden = !debug.hidden;
    },

    setCombo(_count: number) {
      // No-op: KineticHud already drives its combo meter from flashPunch/callout.
    },

    setCoachCard(_card) {
      // No-op: the post-match screen fetches its coach card from the backend.
    },

    setOpponentName(name) {
      opponentName = name;
    },

    setCameraActive(on) {
      const stage = document.getElementById('stage');
      if (stage) stage.style.display = on ? '' : 'none';
    },

    get playerName() {
      return playerName;
    },

    dispose() {
      clear();
      hud?.destroy();
      link.dispose();
      layer.remove();
    },
  };
  return api;
}
