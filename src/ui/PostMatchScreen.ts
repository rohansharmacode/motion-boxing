// Post-match screen: result, score, round stats, AI coach card, top-10 leaderboard, Rematch / Home.
// Shows an "Analysing your form..." loader while `data` is pending and an offline message if it rejects.
//
//   new PostMatchScreen(container, {
//     ctx, result: 'KO_WIN', score: 1840, stats: session.stats(), playerId: session.playerId,
//     data: session.end({ finalScore: 1840, result: 'KO_WIN' }),
//     onRematch: () => startRound(),
//   });
//
// Keyboard: R = rematch, Esc = home. Clicking an action fades the screen out, removes it,
// then calls onRematch / onHome (or ctx.exit() when onHome is omitted).

import type { CoachCard, LeaderboardEntry, RoundResult, RoundStats, SessionEndResponse } from '../api/types';
import { artImg, el, ensurePositioned, html, isTyping, leave, prefersReducedMotion } from './dom';
import { ICONS } from './icons';
import type { GameContext } from './shellTypes';

export interface PostMatchScreenOptions {
  ctx?: GameContext;
  result: RoundResult;
  score: number;
  stats: RoundStats;
  playerId: string;
  data: Promise<SessionEndResponse>;
  onRematch(): void;
  onHome?(): void;
  /** Average guard % over the round, if the engine tracked it. */
  guardPct?: number | null;
}

const RESULT_TEXT: Record<RoundResult, string> = {
  KO_WIN: 'Knockout!',
  WIN: 'You win',
  DRAW: 'Draw',
  LOSS: 'Out-pointed',
  KO_LOSS: 'Knocked down',
};

/** Title-card art per result (public/art/). DRAW has none and keeps the plain text title. */
const RESULT_ART: Partial<Record<RoundResult, string>> = {
  KO_WIN: 'title-ko.svg',
  WIN: 'title-win.svg',
  LOSS: 'title-lose.svg',
  KO_LOSS: 'title-lose.svg',
};

const LOADING_LINES = [
  'Snowflake Cortex is reading your punches…',
  'Comparing your left and right hands…',
  'Checking your guard in the last 15 seconds…',
  'Writing your coach card…',
];

export class PostMatchScreen {
  readonly element: HTMLElement;
  private readonly opts: PostMatchScreenOptions;
  private readonly coachBody = el('div', { class: 'kr-panel-body' });
  private readonly lbBody = el('div', { class: 'kr-panel-body' });
  private readonly source = el('span', { class: 'kr-src kr-src-pending' }, 'Connecting…');
  private readonly rematchBtn: HTMLButtonElement;
  private loadingTimer = 0;
  private raf = 0;
  private closed = false;

  constructor(parent: HTMLElement, opts: PostMatchScreenOptions) {
    this.opts = opts;
    const won = opts.result === 'WIN' || opts.result === 'KO_WIN';
    const scoreNum = el('b', {}, '0');

    this.rematchBtn = el('button', { class: 'kr-btn kr-btn-pink', type: 'button' }, 'Rematch ', el('span', { class: 'kr-kbd kr-kbd-dark' }, 'R'));
    const homeBtn = el('button', { class: 'kr-btn kr-btn-ghost', type: 'button' }, 'Home ', el('span', { class: 'kr-kbd' }, 'Esc'));
    this.rematchBtn.addEventListener('click', () => this.rematch());
    homeBtn.addEventListener('click', () => this.home());

    this.element = el(
      'section',
      { class: 'kr-screen kr-backdrop kr-post kr-post2', 'aria-label': 'Match results' },
      el(
        'div',
        { class: 'kr-post-inner' },
        el(
          'div',
          { class: 'kr-result' },
          el(
            'div',
            {},
            el('div', { class: 'kr-post-chips' }, el('span', { class: 'kr-live' }, el('span', {}, 'Final')), this.source),
            resultTitle(opts.result, won),
          ),
          el('div', { class: 'kr-result-score' }, el('span', { class: 'kr-label' }, 'Score'), scoreNum),
        ),
        this.statsGrid(),
        el(
          'div',
          { class: 'kr-post-grid' },
          el(
            'div',
            { class: 'kr-panel' },
            el('div', { class: 'kr-panel-head' }, el('h2', {}, 'AI Coach'), el('span', { class: 'kr-powered' }, 'Powered by ', el('b', {}, 'Snowflake Cortex'))),
            this.coachBody,
          ),
          el('div', { class: 'kr-panel' }, el('div', { class: 'kr-panel-head' }, el('h2', {}, 'Top 10')), this.lbBody),
        ),
        el('div', { class: 'kr-post-actions' }, this.rematchBtn, homeBtn),
      ),
    );

    this.showLoading();
    ensurePositioned(parent);
    parent.append(this.element);
    window.addEventListener('keydown', this.onKey);
    this.countUp(scoreNum, opts.score);
    requestAnimationFrame(() => this.rematchBtn.focus({ preventScroll: true }));

    opts.data.then(
      (d) => this.showData(d),
      (err: unknown) => this.showOffline(err),
    );
  }

  rematch(): void {
    this.close(() => this.opts.onRematch());
  }

  home(): void {
    this.close(() => (this.opts.onHome ? this.opts.onHome() : this.opts.ctx?.exit()));
  }

  /** Remove immediately, no callbacks. */
  destroy(): void {
    this.closed = true;
    this.cleanup();
    this.element.remove();
  }

  // ---- internals ----

  private onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      this.rematch();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.home();
    }
  };

  private close(then: () => void) {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
    void leave(this.element).then(then);
  }

  private cleanup() {
    window.removeEventListener('keydown', this.onKey);
    clearInterval(this.loadingTimer);
    cancelAnimationFrame(this.raf);
  }

  private countUp(node: HTMLElement, target: number) {
    const final = Math.round(target).toLocaleString();
    if (prefersReducedMotion() || target <= 0) {
      node.textContent = final;
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 1000);
      const eased = 1 - (1 - k) ** 3;
      node.textContent = k >= 1 ? final : Math.round(target * eased).toLocaleString();
      if (k < 1) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private statsGrid() {
    const s = this.opts.stats;
    const acc = s.punches ? `${Math.round((s.landed / s.punches) * 100)}%` : '–';
    const items: [string, string][] = [
      [String(s.punches), 'Punches'],
      [acc, 'Accuracy'],
      [s.maxSpeed.toFixed(1), 'Top SW/s'],
      [`x${s.bestCombo}`, 'Best combo'],
      [String(s.blocks), 'Blocks'],
      [String(s.dodges), 'Slips'],
      [s.avgReactionMs != null ? String(s.avgReactionMs) : '–', 'Reaction ms'],
    ];
    const g = this.opts.guardPct;
    if (g != null) items.push([`${Math.round(g)}%`, 'Guard']);
    return el('div', { class: 'kr-stats' }, ...items.map(([v, l]) => el('div', { class: 'kr-stat' }, el('b', {}, v), el('span', {}, l))));
  }

  private showLoading() {
    const line = el('span', { class: 'kr-loading-sub' }, LOADING_LINES[0]);
    let i = 0;
    this.loadingTimer = window.setInterval(() => (line.textContent = LOADING_LINES[++i % LOADING_LINES.length]), 1600);
    this.coachBody.replaceChildren(
      el(
        'div',
        { class: 'kr-loading', role: 'status' },
        el('div', { class: 'kr-loading-bars' }, ...Array.from({ length: 5 }, () => el('i'))),
        el('b', { class: 'kr-analysing' }, 'Analysing your form', el('span', { class: 'kr-dots' }, el('i', {}, '.'), el('i', {}, '.'), el('i', {}, '.'))),
        line,
        el('div', { style: 'width:80%' }, el('div', { class: 'kr-skel' }), el('div', { class: 'kr-skel', style: 'width:70%' })),
      ),
    );
    this.lbBody.replaceChildren(...Array.from({ length: 5 }, (_, k) => el('div', { class: 'kr-skel', style: `width:${92 - k * 6}%` })));
  }

  private showData(d: SessionEndResponse) {
    if (this.closed) return;
    clearInterval(this.loadingTimer);
    this.setSource(d.source ?? 'live');
    this.coachBody.replaceChildren(coachView(d.coach, d.form_score));
    this.lbBody.replaceChildren(leaderboardTable(d.leaderboard, this.opts.playerId));
  }

  private showOffline(err: unknown) {
    if (this.closed) return;
    console.warn('[ui] post-match data failed', err);
    clearInterval(this.loadingTimer);
    this.setSource('offline');
    this.coachBody.replaceChildren(
      el(
        'div',
        { class: 'kr-offline' },
        el('b', {}, 'Coach is offline'),
        el('p', {}, "We couldn't reach Snowflake for your coach card. Your stats above are still from this round, so go again and we'll retry."),
      ),
    );
    this.lbBody.replaceChildren(el('p', { class: 'kr-hint' }, 'Leaderboard unavailable offline.'));
  }

  private setSource(s: 'live' | 'mock' | 'offline') {
    this.source.className = `kr-src kr-src-${s}`;
    this.source.textContent = s === 'live' ? 'Live · Snowflake' : s === 'mock' ? 'Mock data' : 'Offline';
  }
}

/** The h1 keeps the text for screen readers; the title-card art (if any) replaces it visually. */
function resultTitle(result: RoundResult, won: boolean) {
  const h1 = el('h1', { class: `kr-result-title ${won ? '' : 'kr-loss'}` });
  const text = el('span', { class: 'kr-result-text' }, RESULT_TEXT[result]);
  const file = RESULT_ART[result];
  if (!file) {
    h1.append(text);
    return h1;
  }
  h1.classList.add('kr-result-has-art');
  h1.append(text, artImg(file, 'kr-result-art', () => h1.classList.remove('kr-result-has-art')));
  return h1;
}

function coachView(c: CoachCard, form: number | null | undefined) {
  return el(
    'div',
    { class: 'kr-coach-in' },
    el('p', { class: 'kr-coach-headline' }, c.headline),
    el('ol', { class: 'kr-coach-tips' }, ...c.tips.slice(0, 3).map((t) => el('li', {}, t))),
    el(
      'div',
      { class: 'kr-coach-foot' },
      el('div', { class: 'kr-drill' }, el('h3', {}, 'Your drill'), el('b', {}, c.drill.name), el('p', {}, c.drill.description)),
      el('div', { class: 'kr-badge' }, html(ICONS.BADGE), el('b', {}, c.badge.name), el('p', {}, c.badge.description)),
    ),
    form != null ? formBar(form) : null,
  );
}

function formBar(score: number) {
  const fill = el('div', { style: 'width:0%' });
  requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = `${Math.max(0, Math.min(100, score))}%`)));
  return el('div', { class: 'kr-form' }, 'Form score', el('div', { class: 'kr-form-bar' }, fill), el('b', {}, String(Math.round(score))));
}

function leaderboardTable(all: LeaderboardEntry[], playerId: string) {
  if (!all.length) return el('p', { class: 'kr-hint' }, 'No scores yet. You could be first.');
  const sorted = [...all].sort((a, b) => a.rank - b.rank);
  const rows = sorted.slice(0, 10);
  const me = sorted.slice(10).find((r) => r.player_id === playerId);
  const row = (r: LeaderboardEntry) =>
    el(
      'tr',
      { class: r.player_id === playerId ? 'kr-you' : '' },
      el('td', {}, String(r.rank)),
      el('td', {}, r.display_name),
      el('td', {}, r.max_speed != null ? r.max_speed.toFixed(1) : '–'),
      el('td', {}, r.score.toLocaleString()),
    );
  return el(
    'table',
    { class: 'kr-lb' },
    el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Player'), el('th', {}, 'Top SW/s'), el('th', {}, 'Score'))),
    el(
      'tbody',
      {},
      ...rows.map(row),
      me ? el('tr', { class: 'kr-lb-gap' }, el('td', { colspan: '4' }, '· · ·')) : null,
      me ? row(me) : null,
    ),
  );
}
