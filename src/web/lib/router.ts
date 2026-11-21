/**
 * Routing — a hash router, deliberately.
 *
 * The panel is served as a static bundle behind an SPA fallback, so either
 * history or hash routing works. Hash wins here because a deep link to
 * `/#/sites/1/posts/x` survives a stale deploy, a bookmark, and a Cloudflare
 * cache purge without any server cooperation — and because the whole panel sits
 * behind an Access redirect that would otherwise have to preserve a path.
 */

import { useEffect, useState } from 'preact/hooks'

export type Route =
  | { name: 'overview' }
  | { name: 'posts', siteId: number }
  | { name: 'post', siteId: number, slug: string }
  | { name: 'new-post', siteId: number }
  | { name: 'pages', siteId: number }
  | { name: 'shelf', siteId: number }
  | { name: 'config', siteId: number }
  | { name: 'media', siteId: number, folder?: string }
  | { name: 'tasks', siteId: number }
  | { name: 'history', siteId: number }
  | { name: 'audit', siteId: number }
  | { name: 'sites' }
  | { name: 'users' }

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').replace(/\/$/, '')
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)

  if (!parts.length) return { name: 'overview' }
  if (parts[0] === 'sites') {
    if (parts.length === 1) return { name: 'sites' }
    const siteId = Number.parseInt(parts[1], 10)
    if (!Number.isFinite(siteId)) return { name: 'sites' }
    const section = parts[2]
    switch (section) {
      case undefined: return { name: 'overview' }
      case 'posts':
        if (parts[3] === 'new') return { name: 'new-post', siteId }
        if (parts[3]) return { name: 'post', siteId, slug: parts[3] }
        return { name: 'posts', siteId }
      case 'pages': return { name: 'pages', siteId }
      case 'shelf': return { name: 'shelf', siteId }
      case 'config': return { name: 'config', siteId }
      case 'media': return { name: 'media', siteId, folder: parts[3] }
      case 'tasks': return { name: 'tasks', siteId }
      case 'history': return { name: 'history', siteId }
      case 'audit': return { name: 'audit', siteId }
      default: return { name: 'overview' }
    }
  }
  if (parts[0] === 'users') return { name: 'users' }
  return { name: 'overview' }
}

export function hrefOf(route: Route): string {
  switch (route.name) {
    case 'overview': return '#/'
    case 'sites': return '#/sites'
    case 'users': return '#/users'
    default: {
      const base = `#/sites/${route.siteId}`
      switch (route.name) {
        case 'posts': return `${base}/posts`
        case 'post': return `${base}/posts/${encodeURIComponent(route.slug)}`
        case 'new-post': return `${base}/posts/new`
        case 'pages': return `${base}/pages`
        case 'shelf': return `${base}/shelf`
        case 'config': return `${base}/config`
        case 'media': return `${base}/media${route.folder ? `/${route.folder}` : ''}`
        case 'tasks': return `${base}/tasks`
        case 'history': return `${base}/history`
        case 'audit': return `${base}/audit`
        default: return base
      }
    }
  }
}

export function navigate(route: Route): void {
  const next = hrefOf(route)
  if (window.location.hash === next) return
  window.location.hash = next
}

/**
 * The current route, re-rendered on hash change.
 *
 * Moving between screens is an instantaneous cut, and focus follows it to the
 * new heading — without that, a keyboard user is left on an element that no
 * longer exists.
 */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))

  useEffect(() => {
    const onChange = () => {
      const next = parseRoute(window.location.hash)

      /*
       * A new screen starts at the top.
       *
       * Without this the browser keeps the previous page's scroll offset, so
       * switching from a long list to a short page lands partway down it and the
       * heading appears to jump. Measured: headings were seen at 673px on a page
       * whose correct position is 120px.
       */
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      /*
       * No view transition between screens.
       *
       * `startViewTransition` cross-fades a snapshot of the old page over the
       * new one. On a management panel that reads as flicker: the two screens
       * are visibly superimposed for 180ms, and a screenshot at 60ms shows the
       * post list bleeding through the shelf. There is nothing continuous
       * between two screens to animate, so the cut is the honest transition —
       * the browser's own instantaneous one.
       */
      setRoute(next)
      // Focus still moves: a screen change must not leave the keyboard user on
      // an element that no longer exists.
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[data-view-heading]')?.focus()
      })
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}
