// DEV ONLY: fakes the 15-frame "hold stance" gate. Replace with the real PosePipeline.
import type { CalibrationOverlay } from '../ui';
import { wait } from '../ui/dom';

export async function runMockCalibration(cal: CalibrationOverlay) {
  cal.setState('searching');
  await wait(900);
  for (let f = 1; f <= 15; f++) {
    cal.setProgress(f / 15);
    await wait(2000 / 15);
  }
  await cal.complete();
}
