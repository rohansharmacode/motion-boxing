// Legacy HUD factory: a thin wrapper over BoxingHUD (see BoxingHUD.ts for the full API).
//
//   const hud = createHud(uiRoot, { playerName: 'NAMAN', opponentName: 'UNIT-07' });
//   hud.update({ playerHp: 80, opponentHp: 55, timeLeftMs: 31000 });
//   hud.punch({ type: 'HOOK', speed: 3.1, landed: true });
//   hud.playerHit();
//   hud.banner('Blocked!', 'good');
//   hud.destroy();

import { BoxingHUD } from './BoxingHUD';

export interface HudOptions {
  playerName: string;
  opponentName?: string;
  maxHp?: number;
  /** Speed that fills the gauge, in shoulder-widths per second. */
  maxSpeed?: number;
}

export interface HudState {
  playerHp: number;
  opponentHp: number;
  timeLeftMs: number;
  combo: number;
}

export interface Hud {
  update(s: Partial<HudState>): void;
  punch(p: { type?: string; speed: number; landed?: boolean }): void;
  playerHit(): void;
  banner(text: string, tone?: 'good' | 'bad'): void;
  setMode(label: string | null): void;
  destroy(): void;
  readonly element: HTMLElement;
}

export function createHud(root: HTMLElement, opts: HudOptions): Hud {
  return new BoxingHUD(root, opts);
}
