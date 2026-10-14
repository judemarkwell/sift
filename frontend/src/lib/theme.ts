import { useEffect, useState } from 'react'

export type Theme = 'system' | 'light' | 'dark'
const KEY = 'sift-theme'

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function apply(theme: Theme) {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
}

/** Applied as early as possible (main.tsx) so there's no flash of the wrong theme. */
export function applyStoredTheme() {
  apply(read())
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(read)
  useEffect(() => {
    apply(theme)
    try {
      if (theme === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, theme)
    } catch {
      /* private mode: the choice just won't persist */
    }
  }, [theme])
  return [theme, setTheme]
}
