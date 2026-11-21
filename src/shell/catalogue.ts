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

const PIN = svg(`
  <path d="M40 6c-4 0-5 5-4 9 1 4-6 8-6 18 0 9 4 15 10 15s10-6 10-15c0-10-7-14-6-18 1-4 0-9-4-9z"/>
  <path d="M35.5 15h9" stroke-width="2.6"/>
  <circle cx="20" cy="46" r="12"/>
  <path d="M16 42h.01M22 41h.01M19 47h.01" stroke-width="4"/>`)

const PADDLE = svg(`
  <circle cx="26" cy="26" r="16"/>
  <path d="M37 37l13 13" stroke-width="5"/>
  <circle cx="48" cy="16" r="4"/>`)

const RACKET = svg(`
  <ellipse cx="26" cy="24" rx="14" ry="17"/>
  <path d="M35 37l15 15" stroke-width="5"/>
  <path d="M16 18h20M14 26h24M26 8v32" stroke-width="1.4" opacity=".6"/>
  <circle cx="50" cy="14" r="5"/>`)

const VERSUS = svg(`
  <circle cx="18" cy="26" r="10"/>
  <circle cx="46" cy="26" r="10"/>
  <path d="M6 54c0-9 5-15 12-15s12 6 12 15M34 54c0-9 5-15 12-15s12 6 12 15"/>
  <path d="M27 10l5 8 5-8" stroke-width="2.6"/>`)
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
    id: 'bowling',
    title: 'Bowling',
    tagline: 'Swing, roll, strike',
    howTo: 'Swing your arm forward like an underarm bowl. Faster swing, faster ball. 3 frames.',
    accent: pick('#ff2e88', '#ff6b6b'),
    accent2: pick('#22e5ff', '#2f9bff'),
    icon: PIN,
    art: `${import.meta.env.BASE_URL}art/tile-bowling.svg`,
  },
  {
    id: 'tabletennis',
    title: 'Table Tennis',
    tagline: 'Flick, spin, rally',
    howTo: 'Move your hand to the ball and swing as it reaches you. First to 7 beats the robot.',
    accent: pick('#22e5ff', '#2f9bff'),
    accent2: pick('#ff2e88', '#ff6b6b'),
    icon: PADDLE,
    art: `${import.meta.env.BASE_URL}art/tile-tabletennis.svg`,
  },
  {
    id: 'tennis',
    title: 'Tennis',
    tagline: 'Serve, swing, smash',
    howTo: 'Reach toward the ball and swing hard as it arrives. First to 2 games beats the robot.',
    accent: pick('#b8ff00', '#35c26b'),
    accent2: pick('#22e5ff', '#46c7d9'),
    icon: RACKET,
    art: `${import.meta.env.BASE_URL}art/tile-tennis.svg`,
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
    id: 'versus',
    title: '1v1 Online',
    tagline: 'Box a friend on another laptop',
    howTo: 'Make a room, share the 4-letter code, and fight live over the internet.',
    accent: pick('#ff2e88', '#ff6b6b'),
    accent2: pick('#22e5ff', '#2f9bff'),
    icon: VERSUS,
    art: BRIGHT ? artUrl('tile-boxing') : `${import.meta.env.BASE_URL}art/neon/tile-boxing.svg`,
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
