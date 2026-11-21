// Bright theme palette: sunny island resort. Original colours, shared by the 3D scenes and mirrored in theme.css.
export const SKY = {
  top: 0x3fa7ee,
  mid: 0x8fd3fb,
  horizon: 0xe9f7ff,
  haze: 0xcfeefc,
} as const

export const SEA = { deep: 0x1f8fd0, shallow: 0x46c7d9, foam: 0xf4fdff } as const
export const LAND = { sand: 0xf6dfa4, sandShade: 0xe9c983, grass: 0x8fd16a, grassShade: 0x6fb553, rock: 0xc9c3b6 } as const
export const PALM = { trunk: 0xc89a62, trunkRing: 0xa97b48, leaf: 0x4fb84a, leafLight: 0x7fd25a, coconut: 0x8a5a30 } as const
export const CLOUD = 0xffffff

/** Boxing ring and props. */
export const RING = {
  mat: 0x5fb6f0,
  matEdge: 0x3f93d4,
  apron: 0xffffff,
  rope: 0xffffff,
  ropeAlt: 0xff6f6f,
  post: 0xf2f4f7,
  padLeft: 0x4aa8ff,
  padRight: 0xff6b5a,
  deck: 0xd9a86b,
} as const

/** Player gloves and opponent. Left glove blue, right glove red-coral. */
export const BOXING = {
  bg: SKY.mid,
  left: 0x3d9bff,
  right: 0xff5a4e,
  drone: 0xffb347, // opponent accent (sash, shorts trim)
  droneCore: 0xffffff,
  telegraph: 0xff3b4a,
  counter: 0xffd23c,
} as const

/** Avatar skin tones and outfit swatches, all original. */
export const SKIN = [0xffd7b5, 0xf1c08f, 0xd99b6c, 0xa86b45, 0x7a4b2e] as const
export const OUTFIT = [0xff5a4e, 0x3d9bff, 0x35c26b, 0xffb347, 0xb07cff, 0xff7fb5] as const

/** DOM colours as CSS strings (mirrors theme.css custom properties). */
export const CSS = {
  ink: '#28344a',
  muted: '#6b7a90',
  surface: '#ffffff',
  sky: '#8fd3fb',
  primary: '#2f9bff',
  primaryDark: '#1b78d6',
  accent: '#ffb347',
  good: '#35c26b',
  danger: '#ff5a4e',
} as const

export const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`
