import { useEffect, useState } from 'react'

export type Page = 'chat' | 'compare' | 'usage' | 'skills' | 'plans'

export interface Route {
  page: Page
  id?: string
}

const PAGES: Page[] = ['chat', 'compare', 'usage', 'skills', 'plans']

export function parse(hash: string): Route {
  const [page, id] = hash.replace(/^#\/?/, '').split('/')
  if (PAGES.includes(page as Page)) return { page: page as Page, id: id || undefined }
  return { page: 'chat' }
}

export function href(route: Route): string {
  return `#/${route.page}${route.id ? `/${route.id}` : ''}`
}

export function navigate(route: Route, replace = false) {
  const next = href(route)
  if (replace) history.replaceState(null, '', next)
  else if (location.hash !== next) location.hash = next
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/** Tiny hash router: the URL is the source of truth, so reload and back/forward work. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parse(location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
