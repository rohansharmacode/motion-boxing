// Tile catalogue. Original line-art icons, drawn for this project.
import { isBright } from '../theme/index.ts'
import type { TileInfo } from './types.ts'

const BRIGHT = isBright()

/** URL of a file in public/art (public/art/bright under the bright theme). BASE_URL keeps it working under any deploy base. */
export const artUrl = (name: string): string =>
  BRIGHT ? `${import.meta.env.BASE_URL}art/bright/${name}.svg` : `${import.meta.env.BASE_URL}art/${name}.svg`

/** Neon colours, or the bright island palette. */
const pick = <T,>(neon: T, bright: T): T => (BRIGHT ? bright : neon)

const svg = (body: string): string =>
  `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

const GLOVE = svg(`
  <path d="M20 30c-3-8 1-18 12-19 9-1 15 5 15 13v6c3 1 5 4 5 7 0 4-3 7-7 7H27c-5 0-8-3-8-7z"/>
  <path d="M41 30c-4 0-7 2-8 5"/>
  <rect x="22" y="44" width="22" height="9" rx="3"/>
  <path d="M28 48.5h10"/>`)

const GOAL = svg(`
  <path d="M8 50V16h48v34"/>
  <path d="M8 16l6 8h36l6-8M14 24v26M50 24v26M14 32h36M14 40h36M23 24v26M32 24v26M41 24v26" stroke-width="1.6" opacity=".55"/>
  <circle cx="32" cy="50" r="7"/>
  <path d="M29 46.5l3 2 3-2M32 48.5v4" stroke-width="2"/>`)

const TARGET = svg(`
  <circle cx="28" cy="36" r="20"/>
  <circle cx="28" cy="36" r="12"/>
  <circle cx="28" cy="36" r="4"/>
  <path d="M28 36L54 10M47 10h7v7M54 10l-4 1" />`)

const PODIUM = svg(`
  <path d="M8 54h48"/>
  <rect x="24" y="26" width="16" height="28" rx="2"/>
  <rect x="8" y="36" width="16" height="18" rx="2"/>
  <rect x="40" y="42" width="16" height="12" rx="2"/>
  <path d="M32 8l2.6 5.4 5.9.8-4.3 4.1 1 5.8L32 21.3 26.8 24l1-5.8-4.3-4.1 5.9-.8z" stroke-width="2.4"/>`)

const FIGURE = svg(`
  <circle cx="32" cy="16" r="8"/>
  <path d="M18 56V40c0-8 6-13 14-13s14 5 14 13v16"/>
  <path d="M26 56V44M38 56V44"/>`)

export const TILES: readonly TileInfo[] = [
  {
    id: 'boxing',
    title: 'Boxing',
    tagline: pick('Out-punch the sparring drone', 'Box the island champ'),
    howTo: 'Jab, cross, hook, uppercut. Guard up to block, lean to slip.',
    accent: pick('#ff5a1f', '#ff5a4e'),
    accent2: pick('#ff2d75', '#ffb347'),
    icon: GLOVE,
    art: artUrl('tile-boxing'),
    featured: true,
  },
  {
    id: 'goalkeeper',
    title: 'Goalkeeper',
    tagline: 'Dive, reach, save',
    howTo: 'Shots fly at your goal. Get a hand in the way.',
    accent: pick('#38c8ff', '#35c26b'),
    accent2: pick('#3cf2b0', '#46c7d9'),
    icon: GOAL,
    art: artUrl('tile-goalkeeper'),
  },
  {
    id: 'archery',
    title: 'Archery',
    tagline: pick('Draw, hold, release', 'Draw, aim, bullseye'),
    howTo: 'Pull your hand back to draw, open up to loose the arrow.',
    accent: pick('#ffd23c', '#ffd23c'),
    accent2: pick('#ff8a1f', '#ff9a3c'),
    icon: TARGET,
    art: artUrl('tile-archery'),
  },
  {
    id: 'customise',
    title: 'Customise',
    tagline: 'Make your fighter yours',
    howTo: 'Pick your colours, gloves and look. Your fighter keeps them in every sport.',
    accent: pick('#3cf2b0', '#35c26b'),
    accent2: pick('#22e5ff', '#46c7d9'),
    icon: FIGURE,
    art: artUrl('tile-customise'),
  },
  {
    id: 'leaderboard',
    title: 'Leaderboard',
    tagline: 'Live stats powered by Snowflake',
    howTo: 'Every punch streams to Snowflake. See who hits hardest.',
    accent: pick('#a98bff', '#2f9bff'),
    accent2: pick('#38c8ff', '#8fd3fb'),
    icon: PODIUM,
    art: artUrl('tile-leaderboard'),
  },
]
