// Tiny external store for the in-round HUD. The engine can push updates up to
// 60x/s; each HUD widget subscribes to its own slice, so only what changed re-renders.
import { useSyncExternalStore } from 'react';
import type { HudEvent, HudState, PunchInfo } from './types';

export interface HudSnapshot extends HudState {
  lastPunch: PunchInfo | null;
  punchSeq: number;
  event: HudEvent | null;
  eventSeq: number;
  /** ms timestamp when the opponent's telegraph started, or null. */
  telegraphAt: number | null;
  hitSeq: number;
  bigHitSeq: number;
}

export interface HudStore {
  get: () => HudSnapshot;
  subscribe: (fn: () => void) => () => void;
  /** Merge engine state (call per frame). */
  update: (patch: Partial<HudState>) => void;
  punch: (p: PunchInfo) => void;
  event: (e: HudEvent) => void;
  /** Player got hit; big = screen shake. */
  hit: (big?: boolean) => void;
  telegraph: (on: boolean) => void;
}

export function createHudStore(initial: HudState, extra: Partial<HudSnapshot> = {}): HudStore {
  let s: HudSnapshot = { ...initial, lastPunch: null, punchSeq: 0, event: null, eventSeq: 0, telegraphAt: null, hitSeq: 0, bigHitSeq: 0, ...extra };
  const subs = new Set<() => void>();
  const set = (patch: Partial<HudSnapshot>) => {
    let changed = false;
    for (const k in patch) if ((patch as Record<string, unknown>)[k] !== (s as unknown as Record<string, unknown>)[k]) { changed = true; break; }
    if (!changed) return;
    s = { ...s, ...patch };
    subs.forEach((f) => f());
  };
  return {
    get: () => s,
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    update: (p) => set(p),
    punch: (p) => set({ lastPunch: p, punchSeq: s.punchSeq + 1 }),
    event: (e) => set({ event: e, eventSeq: s.eventSeq + 1 }),
    hit: (big = false) => set({ hitSeq: s.hitSeq + 1, bigHitSeq: big ? s.bigHitSeq + 1 : s.bigHitSeq, combo: 0 }),
    telegraph: (on) => set({ telegraphAt: on ? performance.now() : null }),
  };
}

export function useHud<T>(store: HudStore, select: (s: HudSnapshot) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
