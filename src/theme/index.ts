// Theme switch. ?theme=bright|neon picks a theme and remembers it; the default is bright.
// Importing this module applies the theme to <html data-theme> and loads its fonts and CSS.
import './bright/theme.css'
import '../fonts/index.ts'
import { DEFAULT_THEME, THEME_IDS } from './types.ts'
import type { ThemeId } from './types.ts'

export type { ThemeId } from './types.ts'
export { DEFAULT_THEME, THEME_IDS } from './types.ts'

const STORAGE_KEY = 'kinetic.theme'

const isThemeId = (v: unknown): v is ThemeId => typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v)

function readTheme(): ThemeId {
  try {
    const fromUrl = new URLSearchParams(location.search).get('theme')
    if (isThemeId(fromUrl)) {
      localStorage.setItem(STORAGE_KEY, fromUrl)
      return fromUrl
    }
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isThemeId(stored)) return stored
  } catch {
    // Private mode or no window: fall through to the default.
  }
  return DEFAULT_THEME
}

let current: ThemeId | null = null

/** The active theme. Stable for the page's lifetime. */
export function activeTheme(): ThemeId {
  if (current === null) current = typeof window === 'undefined' ? DEFAULT_THEME : readTheme()
  return current
}

export const isBright = (): boolean => activeTheme() === 'bright'

/** Sets <html data-theme>, theme-color and the bright fonts. Safe to call more than once. */
export function applyTheme(): ThemeId {
  const theme = activeTheme()
  if (typeof document === 'undefined') return theme
  const html = document.documentElement
  html.dataset.theme = theme
  if (theme === 'bright') {
    html.style.colorScheme = 'light'
    // Fonts are self-hosted (src/fonts), bundled with this module: nothing to fetch from the internet.
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'theme-color'
      document.head.append(meta)
    }
    meta.content = '#7cc8f5'
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (icon) icon.href = `${import.meta.env.BASE_URL}favicon-bright.svg`
  }
  return theme
}

applyTheme()
