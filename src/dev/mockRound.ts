// DEV ONLY: a fake boxing round so the UI + API client can be tested without the
// pose pipeline or Three.js. Replace with the real BoxingEngine when it lands.
//
// Keys: J jab (L), K cross (R), H hook, U uppercut, Space block, ← / → slip.

import { emitMotionEvent } from '../api/client';
import type { PunchType, RoundResult } from '../api/types';
import type { Hud } from '../ui';

export interface MockRoundResult {
  result: RoundResult;
  score: number;
}

const KEYS: Record<string, { type: PunchType; hand: 'L' | 'R'; dmg: number }> = {
  j: { type: 'JAB', hand: 'L', dmg: 4 },
  k: { type: 'CROSS', hand: 'R', dmg: 6 },
  h: { type: 'HOOK', hand: 'L', dmg: 8 },
  u: { type: 'UPPERCUT', hand: 'R', dmg: 9 },
};

export function runMockRound(hud: Hud, roundMs: number): Promise<MockRoundResult> {
  return new Promise((resolve) => {
    let playerHp = 100;
    let foeHp = 100;
    let score = 0;
    let combo = 0;
    let blocking = false;
    let dodgeUntil = 0;
    let telegraphAt = 0;
    let nextAttack = performance.now() + 2500;
    const start = performance.now();
    let raf = 0;

    hud.setMode('Keyboard mode · J K H U punch · Space block · ← → slip');

    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const now = performance.now();
      const k = e.key.toLowerCase();
      if (KEYS[k]) {
        const p = KEYS[k];
        const speed = +(1.8 + Math.random() * 2.6).toFixed(2);
        const landed = Math.random() < 0.78;
        const dmg = landed ? p.dmg * (speed / 3) * (now < dodgeUntil + 1500 ? 1.5 : 1) : 0;
        foeHp = Math.max(0, foeHp - dmg);
        combo = landed ? combo + 1 : 0;
        score += Math.round(dmg * 10 * (1 + combo * 0.1));
        hud.punch({ type: p.type, speed, landed });
        emitMotionEvent({
          event_type: 'PUNCH',
          peak_velocity: speed,
          accuracy_score: landed ? Math.round(60 + Math.random() * 40) : Math.round(Math.random() * 40),
          metrics: { punchType: p.type, hand: p.hand, landed, elbowAngle: Math.round(140 + Math.random() * 30) },
        });
      } else if (k === ' ') {
        e.preventDefault();
        blocking = true;
        emitMotionEvent({ event_type: 'BLOCK', reaction_ms: telegraphAt ? Math.round(now - telegraphAt) : undefined });
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        dodgeUntil = now + 400;
        emitMotionEvent({
          event_type: 'DODGE',
          reaction_ms: telegraphAt ? Math.round(now - telegraphAt) : undefined,
          metrics: { direction: e.key === 'ArrowLeft' ? 'L' : 'R' },
        });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') blocking = false;
    };

    const loop = (now: number) => {
      const left = roundMs - (now - start);

      if (!telegraphAt && now >= nextAttack) {
        telegraphAt = now;
        hud.banner('Incoming!');
      } else if (telegraphAt && now - telegraphAt >= 600) {
        if (now < dodgeUntil) {
          hud.banner('Slipped! Counter!', 'good');
        } else if (blocking) {
          playerHp -= 2;
          hud.banner('Blocked', 'good');
        } else {
          playerHp -= 12;
          combo = 0;
          hud.playerHit();
        }
        telegraphAt = 0;
        nextAttack = now + 1600 + Math.random() * 1800;
      }

      hud.update({ playerHp, opponentHp: foeHp, timeLeftMs: left });

      if (left <= 0 || foeHp <= 0 || playerHp <= 0) {
        cancelAnimationFrame(raf);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKeyUp);
        hud.setMode(null);
        const result: RoundResult =
          foeHp <= 0 ? 'KO_WIN' : playerHp <= 0 ? 'KO_LOSS' : foeHp < playerHp ? 'WIN' : foeHp > playerHp ? 'LOSS' : 'DRAW';
        const bonus = result === 'KO_WIN' ? 500 + Math.round(Math.max(0, left) / 100) : 0;
        resolve({ result, score: score + bonus + Math.round(playerHp * 5) });
        return;
      }
      raf = requestAnimationFrame(loop);
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    raf = requestAnimationFrame(loop);
  });
}
