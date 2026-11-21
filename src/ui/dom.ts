// Tiny DOM helpers so the UI has no framework dependency.
import { isBright } from '../theme/index.ts';
import '../theme/bright/ui.css';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> & { class?: string } = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

/** Parse a trusted, static HTML/SVG snippet. Never pass user input here. */
export function html(markup: string): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content;
}

/** Fade a screen out, then remove it. */
export function leave(node: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    node.classList.add('kr-leaving');
    const done = () => {
      node.remove();
      resolve();
    };
    node.addEventListener('animationend', done, { once: true });
    setTimeout(done, 400); // reduced-motion / no animation fallback
  });
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Zero-padded mm:ss, e.g. 01:00, 00:09. */
export const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Overlays are `position:absolute; inset:0`, so make sure the container is a containing block. */
export function ensurePositioned(parent: HTMLElement) {
  if (parent === document.body || parent === document.documentElement) return;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
}

/** Is the keyboard event aimed at a text field (so global shortcuts should ignore it)? */
export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}

/** URL of a file in public/art/, honouring Vite's base path. */
/** Art files that have a bright-theme version in public/art/bright/. */
const BRIGHT_ART = new Set([
  'title-ko.svg',
  'title-win.svg',
  'title-lose.svg',
  'splash-get-ready.svg',
  'splash-loading.svg',
  'tile-boxing.svg',
  'tile-goalkeeper.svg',
  'tile-archery.svg',
  'tile-leaderboard.svg',
  'tile-coming-soon.svg',
  'calibration-silhouette.svg',
]);

/** URL of a file in public/art/ (or public/art/bright/ in the bright theme), honouring Vite's base path. */
export const artUrl = (file: string) =>
  `${import.meta.env.BASE_URL}art/${isBright() && BRIGHT_ART.has(file) ? 'bright/' : ''}${file}`;

/** Decorative <img> for public/art/ assets. Removes itself (and runs onFail) if the file fails to load. */
export function artImg(file: string, cls: string, onFail?: () => void): HTMLImageElement {
  const img = el('img', { class: cls, src: artUrl(file), alt: '', 'aria-hidden': 'true', decoding: 'async', draggable: 'false' });
  img.addEventListener(
    'error',
    () => {
      img.remove();
      onFail?.();
    },
    { once: true },
  );
  return img;
}
