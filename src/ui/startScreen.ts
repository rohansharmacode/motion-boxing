// Start screen: logo, name entry, sport select.
//   const { name, sport } = await showStartScreen(uiRoot);

import type { Sport } from '../api/types';
import { USE_MOCK } from '../api/client';
import { el, html, leave } from './dom';
import { ICONS } from './icons';

export interface SportOption {
  id: Sport;
  name: string;
  sub: string;
  enabled: boolean;
  tag?: string;
}

export const DEFAULT_SPORTS: SportOption[] = [
  { id: 'BOXING', name: 'Kinetic Ring', sub: 'Boxing. Jab, hook, block, slip.', enabled: true },
  { id: 'GOALKEEPER', name: 'Reflex Keeper', sub: 'Penalty saves. Pure reflex.', enabled: true, tag: 'Beta' },
  { id: 'ARCHERY', name: 'Aero Bow', sub: 'Archery. Hold steady, release.', enabled: false, tag: 'Soon' },
];

const LAST_NAME_KEY = 'kr.lastName';

export interface StartResult {
  name: string;
  sport: Sport;
}

export function showStartScreen(root: HTMLElement, sports: SportOption[] = DEFAULT_SPORTS): Promise<StartResult> {
  return new Promise((resolve) => {
    let selected: Sport = sports.find((s) => s.enabled)?.id ?? 'BOXING';

    const input = el('input', {
      id: 'kr-name',
      type: 'text',
      maxlength: '16',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'YOUR NAME',
      'aria-label': 'Player name',
    });
    input.value = localStorage.getItem(LAST_NAME_KEY) ?? '';

    const cards = sports.map((s) => {
      const card = el(
        'button',
        {
          class: 'kr-sport',
          type: 'button',
          role: 'radio',
          'aria-checked': String(s.id === selected),
          'data-sport': s.id,
        },
        el('span', {}, el('span', { class: 'kr-sport-icon' }, html(ICONS[s.id]))),
        el('span', { class: 'kr-sport-name' }, s.name),
        el('span', { class: 'kr-sport-sub' }, s.sub),
        s.tag ? el('span', { class: 'kr-chip' }, s.tag) : null,
      );
      card.disabled = !s.enabled;
      card.addEventListener('click', () => select(s.id));
      return card;
    });

    const go = el('button', { class: 'kr-btn kr-btn-pink', type: 'submit' }, 'Enter the ring');

    const form = el(
      'form',
      { class: 'kr-start-inner', autocomplete: 'off' },
      el(
        'div',
        { class: 'kr-logo' },
        el('span', { class: 'kr-live' }, el('span', {}, 'Live · 2026')),
        el('h1', {}, 'Kinetic ', el('span', {}, 'Ring')),
        el('p', { class: 'kr-tagline' }, 'No controller. Just you, a webcam and Snowflake.'),
      ),
      el('label', { class: 'kr-name', for: 'kr-name' }, el('span', { class: 'kr-label' }, 'Player'), input),
      el('div', { class: 'kr-sports', role: 'radiogroup', 'aria-label': 'Choose a sport' }, ...cards),
      el(
        'div',
        { class: 'kr-start-foot' },
        go,
        el(
          'span',
          { class: 'kr-hint' },
          'Stand about 1.5 m from the camera. Press ',
          el('span', { class: 'kr-kbd' }, 'D'),
          ' in game for keyboard mode.',
        ),
        USE_MOCK ? el('span', { class: 'kr-chip' }, 'Mock data: no API connected') : null,
      ),
    );

    const screen = el('section', { class: 'kr-screen kr-backdrop kr-start' }, form);
    root.append(screen);

    function select(id: Sport) {
      selected = id;
      for (const c of cards) c.setAttribute('aria-checked', String(c.dataset.sport === id));
    }

    // Arrow keys move between sports.
    form.querySelector('.kr-sports')!.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k !== 'ArrowLeft' && k !== 'ArrowRight') return;
      const enabled = sports.filter((s) => s.enabled);
      const i = enabled.findIndex((s) => s.id === selected);
      const next = enabled[(i + (k === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length];
      select(next.id);
      cards.find((c) => c.dataset.sport === next.id)?.focus();
    });

    const validate = () => {
      go.disabled = input.value.trim().length === 0;
    };
    input.addEventListener('input', validate);
    validate();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return input.focus();
      localStorage.setItem(LAST_NAME_KEY, name);
      await leave(screen);
      resolve({ name, sport: selected });
    });

    requestAnimationFrame(() => input.focus());
  });
}
