import { useState } from 'react';
import type { HudStore } from '../hudStore';
import type { PunchType } from '../types';
import { useHotkeys } from '../components/ui';

export interface DemoControlsProps {
  store: HudStore;
  onKo?: (won: boolean) => void;
}

const TYPES: PunchType[] = ['JAB', 'CROSS', 'HOOK', 'UPPERCUT'];

/** Dev-only panel, toggled with "D". Fires fake events so every HUD state can be shown without a webcam. */
export function DemoControls({ store, onKo }: DemoControlsProps) {
  const [open, setOpen] = useState(false);
  const s = () => store.get();
  const punch = () => {
    const type = TYPES[Math.floor(Math.random() * 4)];
    const speed = 1.5 + Math.random() * 3.3;
    store.punch({ type, speed, landed: true });
    store.update({ opponentHp: Math.max(0, s().opponentHp - (4 + speed * 2)), combo: s().combo + 1 });
    if (s().combo >= 3 && Math.random() < .3) store.event('COUNTER');
  };
  const hit = (big = false) => {
    store.hit(big);
    store.update({ playerHp: Math.max(0, s().playerHp - (big ? 22 : 9)), guardPct: Math.max(0, s().guardPct - 15) });
    store.event('HIT');
  };
  const block = () => { store.event('BLOCK'); store.update({ guardPct: Math.min(100, s().guardPct + 8) }); };
  const slip = () => store.event('SLIP');
  const tele = () => { store.telegraph(true); setTimeout(() => store.telegraph(false), 650); };
  const ko = () => { store.update({ opponentHp: 0 }); store.event('KO'); setTimeout(() => onKo?.(true), 1400); };
  const actions: [string, string, () => void][] = [
    ['1', 'Punch', punch], ['2', 'Hit', () => hit()], ['3', 'Big hit', () => hit(true)], ['4', 'Block', block],
    ['5', 'Slip', slip], ['6', 'Telegraph', tele], ['7', 'Time 0:08', () => store.update({ timeLeftMs: 8000 })], ['9', 'K.O.', ko],
  ];
  useHotkeys({ d: () => setOpen((o) => !o), ...(open ? Object.fromEntries(actions.map(([k, , f]) => [k, f])) : {}) });
  if (!open) return null;
  return (
    <div className="absolute left-1/2 top-28 z-50 w-[26rem] -translate-x-1/2 rounded border border-amber bg-navy/95 p-4 font-display">
      <div className="mb-2 flex justify-between text-sm font-bold uppercase tracking-widest text-amber"><span>Demo controls</span><span>D to hide</span></div>
      <div className="grid grid-cols-4 gap-2">
        {actions.map(([k, label, f]) => (
          <button key={k} onClick={f} className="rounded border border-white/30 bg-navy-3 px-2 py-2 text-sm font-bold text-white hover:border-cyan">
            <span className="block text-xs text-muted">{k}</span>{label}
          </button>
        ))}
      </div>
    </div>
  );
}
