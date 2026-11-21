// Legacy promise-style wrapper over PostMatchScreen.
//
//   const action = await showPostMatch(uiRoot, {
//     result: 'KO_WIN', score: 1840, stats: session.stats(), playerId: session.playerId,
//     data: session.end({ finalScore: 1840, result: 'KO_WIN' }),
//   });
//   if (action === 'rematch') ...

import type { RoundResult, RoundStats, SessionEndResponse } from '../api/types';
import { PostMatchScreen } from './PostMatchScreen';

export type PostMatchAction = 'rematch' | 'menu';

export interface PostMatchOptions {
  result: RoundResult;
  score: number;
  stats: RoundStats;
  playerId: string;
  data: Promise<SessionEndResponse>;
}

export function showPostMatch(root: HTMLElement, opts: PostMatchOptions): Promise<PostMatchAction> {
  return new Promise((resolve) => {
    new PostMatchScreen(root, { ...opts, onRematch: () => resolve('rematch'), onHome: () => resolve('menu') });
  });
}
