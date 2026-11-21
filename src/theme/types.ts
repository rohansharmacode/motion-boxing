// Theme contract. A theme restyles the DOM (CSS variables under [data-theme]) and the 3D scenes.
export type ThemeId = 'bright' | 'neon'

export const THEME_IDS: readonly ThemeId[] = ['bright', 'neon']

/** Default theme when nothing is chosen. */
export const DEFAULT_THEME: ThemeId = 'neon'
