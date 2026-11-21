// Tile catalogue. Original line-art icons, drawn for this project.
import type { TileInfo } from './types.ts'

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

export const TILES: readonly TileInfo[] = [
  {
    id: 'boxing',
    title: 'Boxing',
    tagline: 'Out-punch the sparring drone',
    howTo: 'Jab, cross, hook, uppercut. Guard up to block, lean to slip.',
    accent: '#ff5a1f',
    accent2: '#ff2d75',
    icon: GLOVE,
    featured: true,
  },
  {
    id: 'goalkeeper',
    title: 'Goalkeeper',
    tagline: 'Dive, reach, save',
    howTo: 'Shots fly at your goal. Get a hand in the way.',
    accent: '#38c8ff',
    accent2: '#3cf2b0',
    icon: GOAL,
  },
  {
    id: 'archery',
    title: 'Archery',
    tagline: 'Draw, hold, release',
    howTo: 'Pull your hand back to draw, open up to loose the arrow.',
    accent: '#ffd23c',
    accent2: '#ff8a1f',
    icon: TARGET,
  },
  {
    id: 'leaderboard',
    title: 'Leaderboard',
    tagline: 'Live stats powered by Snowflake',
    howTo: 'Every punch streams to Snowflake. See who hits hardest.',
    accent: '#a98bff',
    accent2: '#38c8ff',
    icon: PODIUM,
  },
]
