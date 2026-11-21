// Legacy entry points. The overlay itself lives in CalibrationOverlay.ts.
//
//   const cal = showCalibration(uiRoot, { sport: 'BOXING' });
//   cal.setState('searching');        // no body found yet
//   cal.setProgress(validFrames / 15); // 0..1, switches to 'holding' when > 0
//   await cal.complete();             // shows LOCKED IN, then removes itself
//   await showCountdown(uiRoot);      // 3, 2, 1, FIGHT

import type { Sport } from '../api/types';
import { CalibrationOverlay } from './CalibrationOverlay';
import { el, wait } from './dom';

export type { CalibrationState } from './CalibrationOverlay';

export function showCalibration(root: HTMLElement, opts: { sport: Sport; playerName?: string }): CalibrationOverlay {
  return new CalibrationOverlay(root, opts);
}

/** Big 3-2-1-FIGHT countdown over the scene. Resolves when FIGHT appears. */
export async function showCountdown(root: HTMLElement, words = ['3', '2', '1'], go = 'Fight!'): Promise<void> {
  const box = el('div', { class: 'kr-countdown', 'aria-live': 'assertive' });
  root.append(box);
  for (const w of words) {
    box.replaceChildren(el('span', {}, w));
    await wait(700);
  }
  box.replaceChildren(el('span', { class: 'kr-go' }, go));
  setTimeout(() => box.remove(), 800);
}
