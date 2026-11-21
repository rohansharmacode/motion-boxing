// Character customisation data: the player's robot look (colour scheme, head, gloves, name).
// Stored as preset ids, so a look is tiny, safe to send to the 1v1 opponent, and easy to validate.

export type SchemeId = 'volt' | 'blaze' | 'magenta' | 'lime' | 'violet' | 'gold'
export type HeadId = 'visor' | 'dome' | 'antenna' | 'block'
export type GloveId = 'classic' | 'cyan' | 'orange' | 'pink' | 'lime' | 'white'

export interface RobotLook {
  name: string
  scheme: SchemeId
  head: HeadId
  glove: GloveId
}

export interface Scheme {
  id: SchemeId
  label: string
  /** Armour base colour (dark, tinted toward the accent). */
  armour: number
  /** Neon edges and trim. */
  accent: number
  /** Visor and chest light. */
  visor: number
}

export const SCHEMES: readonly Scheme[] = [
  { id: 'volt', label: 'Volt', armour: 0x1a2230, accent: 0x38c8ff, visor: 0x9be8ff },
  { id: 'blaze', label: 'Blaze', armour: 0x2a1c1a, accent: 0xff5a1f, visor: 0xffc08a },
  { id: 'magenta', label: 'Magenta', armour: 0x2a1828, accent: 0xff2d95, visor: 0xffa6d2 },
  { id: 'lime', label: 'Lime', armour: 0x1a2a1e, accent: 0x7dff4a, visor: 0xd2ffb8 },
  { id: 'violet', label: 'Violet', armour: 0x201a32, accent: 0xa47bff, visor: 0xe2d4ff },
  { id: 'gold', label: 'Gold', armour: 0x2a2416, accent: 0xffc83a, visor: 0xfff0b0 },
]

export const HEADS: readonly { id: HeadId; label: string }[] = [
  { id: 'visor', label: 'Visor' },
  { id: 'dome', label: 'Dome' },
  { id: 'antenna', label: 'Antenna' },
  { id: 'block', label: 'Block' },
]

/** [left, right] glove colours. */
export const GLOVES: readonly { id: GloveId; label: string; colors: readonly [number, number] }[] = [
  { id: 'classic', label: 'Classic', colors: [0x38c8ff, 0xff5a1f] },
  { id: 'cyan', label: 'Cyan', colors: [0x38c8ff, 0x38c8ff] },
  { id: 'orange', label: 'Orange', colors: [0xff5a1f, 0xff5a1f] },
  { id: 'pink', label: 'Pink', colors: [0xff2d95, 0xff2d95] },
  { id: 'lime', label: 'Lime', colors: [0x7dff4a, 0x7dff4a] },
  { id: 'white', label: 'White', colors: [0xe8ecf4, 0xe8ecf4] },
]

export const NAME_MAX = 16
export const DEFAULT_LOOK: RobotLook = { name: '', scheme: 'volt', head: 'visor', glove: 'classic' }

const STORAGE_KEY = 'kinetic.robot'
/** The Kinetic HUD's name field reads this key, so a name set here shows up there too. */
const HUD_NAME_KEY = 'kr.lastName'

const pick = <T extends string>(value: unknown, list: readonly { id: T }[], fallback: T): T =>
  list.some((o) => o.id === value) ? (value as T) : fallback

export const cleanName = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, NAME_MAX) : ''

/** Any value (storage, network) to a valid look. Unknown ids fall back to the defaults. */
export function sanitizeLook(raw: unknown): RobotLook {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    name: cleanName(r.name),
    scheme: pick(r.scheme, SCHEMES, DEFAULT_LOOK.scheme),
    head: pick(r.head, HEADS, DEFAULT_LOOK.head),
    glove: pick(r.glove, GLOVES, DEFAULT_LOOK.glove),
  }
}

export function loadLook(): RobotLook {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    const look = sanitizeLook(saved ? JSON.parse(saved) : {})
    if (!look.name) look.name = cleanName(localStorage.getItem(HUD_NAME_KEY))
    return look
  } catch {
    return { ...DEFAULT_LOOK }
  }
}

export function saveLook(look: RobotLook): void {
  const clean = sanitizeLook(look)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
    if (clean.name) localStorage.setItem(HUD_NAME_KEY, clean.name)
  } catch {
    // Storage blocked: the look lasts for this page only.
  }
}

export const schemeOf = (look: RobotLook): Scheme => SCHEMES.find((s) => s.id === look.scheme) ?? SCHEMES[0]!
export const gloveColors = (look: RobotLook): readonly [number, number] =>
  (GLOVES.find((g) => g.id === look.glove) ?? GLOVES[0]!).colors
