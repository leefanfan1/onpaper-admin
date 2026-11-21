/**
 * The application shell.
 *
 * Structure, not decoration: the spine carries the site's name and the way back
 * to the site; the top bar carries which site is being edited and its state; the
 * tabs are the six jobs a person actually does here.
 */

import { useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api, bootstrap, isApiError, prefetch, warmSite, type Health, type Site } from './lib/api'
import { hrefOf, navigate, parseRoute, useRoute, type Route } from './lib/router'
import { ErrorBox, Loading, ToastStack, useToasts } from './components/ui'
import { BottomBar } from './components/bottom-bar'
import { OverviewView } from './views/overview'
import { PostsView } from './views/posts'
import { PostEditorView } from './views/post-editor'
import { PagesView } from './views/pages'
import { ShelfView } from './views/shelf'
import { ConfigView } from './views/config'
import { MediaView } from './views/media'
import { TasksView } from './views/tasks'
import { HistoryView } from './views/history'
import { AuditView } from './views/audit'
import { SitesView } from './views/sites'
import { UsersView } from './views/users'

export interface AppContext {
  health: Health
  sites: Site[]
  site: Site | null
  reload: () => Promise<void>
  toast: (tone: 'ok' | 'warn' | 'danger' | 'info', message: string) => void
}

const TABS: Array<{ key: string, label: string, route: (siteId: number) => Route }> = [
  { key: 'posts', label: '文章', route: siteId => ({ name: 'posts', siteId }) },
  { key: 'pages', label: '页面与友链', route: siteId => ({ name: 'pages', siteId }) },
  { key: 'shelf', label: '书架', route: siteId => ({ name: 'shelf', siteId }) },
  { key: 'config', label: '站点配置', route: siteId => ({ name: 'config', siteId }) },
  { key: 'media', label: '媒体', route: siteId => ({ name: 'media', siteId }) },
  { key: 'tasks', label: '任务', route: siteId => ({ name: 'tasks', siteId }) },
  { key: 'history', label: '提交', route: siteId => ({ name: 'history', siteId }) },
  { key: 'audit', label: '审计', route: siteId => ({ name: 'audit', siteId }) },
]

/**
 * The phone bar shows the four jobs that are actually done on a phone, and the
 * rest live behind 更多. Deciding by frequency rather than by symmetry is what
 * makes the bar usable with a thumb.
 */
const PHONE_PRIMARY: Array<{ key: string, label: string, glyph: string, route: (siteId: number) => Route }> = [
  { key: 'posts', label: '文章', glyph: '✎', route: siteId => ({ name: 'posts', siteId }) },
  { key: 'shelf', label: '书架', glyph: '▤', route: siteId => ({ name: 'shelf', siteId }) },
  { key: 'tasks', label: '任务', glyph: '⟳', route: siteId => ({ name: 'tasks', siteId }) },
]

const PHONE_MORE: Array<{ key: string, label: string, glyph: string, route: (siteId: number) => Route }> = [
  { key: 'pages', label: '页面与友链', glyph: '▭', route: siteId => ({ name: 'pages', siteId }) },
  { key: 'config', label: '站点配置', glyph: '⚙', route: siteId => ({ name: 'config', siteId }) },
  { key: 'media', label: '媒体', glyph: '▣', route: siteId => ({ name: 'media', siteId }) },
  { key: 'history', label: '提交', glyph: '⌘', route: siteId => ({ name: 'history', siteId }) },
  { key: 'audit', label: '审计', glyph: '⊙', route: siteId => ({ name: 'audit', siteId }) },
]

export function App(): ComponentChildren {
  const route = useRoute()
  const [health, setHealth] = useState<Health | null>(null)
  const [sites, setSites] = useState<Site[]>([])
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const { toasts, push, dismiss } = useToasts()

  const load = async () => {
    setLoading(true)
    try {
      const result = await bootstrap()
      const list = await api.get<{ sites: Site[] }>('/api/sites')
      setHealth(result)
      setSites(list.sites)
      setError(null)

      /*
       * Warm the screens this person is most likely to open next.
       *
       * The first visit to a tab is the one that costs seconds — it is the only
       * one that still has to reach GitHub. Doing it while they are reading the
       * page they landed on means the tab they click a few seconds later is
       * already answered, and no screen shows a loading row on a normal visit.
       * Deliberately not awaited: this must never delay the first paint, and it
       * is skipped entirely on a metered connection.
       */
      if (list.sites.length) {
        // Warm the site the person is actually on; on the overview or the site
        // list there is no such site, so the first one is the best guess.
        const current = parseRoute(window.location.hash)
        const siteId = 'siteId' in current ? (current as { siteId: number }).siteId : list.sites[0].id
        const known = list.sites.some(site => site.id === siteId)
        const target = known ? siteId : list.sites[0].id
        // Two ways to be fast, because they cover different cases: the Worker
        // warms the cache once per session (a couple of seconds, all at once),
        // and the browser prefetches anything that was already warm so the
        // tab opens with no request at all.
        warmSite(target)
        prefetch(mostlyVisited(target))
      }
    }
    catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)))
    }
    finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  // The theme is the site's, including dark mode. The panel follows the OS by
  // default; the toggle only sets an override.
  useEffect(() => {
    const stored = localStorage.getItem('onpaper-admin-theme')
    if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored
  }, [])

  const setTheme = (mode: 'auto' | 'light' | 'dark') => {
    if (mode === 'auto') {
      delete document.documentElement.dataset.theme
      localStorage.removeItem('onpaper-admin-theme')
    }
    else {
      document.documentElement.dataset.theme = mode
      localStorage.setItem('onpaper-admin-theme', mode)
    }
  }

  if (loading) {
    return <div class="boot"><Loading label="正在连接" /></div>
  }

  if (error) {
    return (
      <div class="boot">
        <ErrorBox error={error} onRetry={() => { void load() }} />
        <p class="hint">
          {isApiError(error) && error.code === 'CONFIG'
            ? '面板还没有配置 Cloudflare Access：需要设置 ACCESS_TEAM_DOMAIN、ACCESS_AUD 和 PANEL_HOSTNAME。'
            : isApiError(error) && error.status === 401
              ? '请通过 Cloudflare Access 登录后再打开面板。'
              : '检查网络或稍后重试。'}
        </p>
      </div>
    )
  }

  if (!health) return null

  const siteId = 'siteId' in route ? (route as { siteId: number }).siteId : null
  const site = siteId ? sites.find(item => item.id === siteId) ?? null : null
  const ctx: AppContext = {
    health,
    sites,
    site,
    reload: load,
    toast: push,
  }

  return (
    <div class="shell">
      <aside class="spine" aria-label="站点">
        <a class="spine__title" href="#/" aria-label="回到总览">纸上管理</a>
        <div class="spine__actions">
          <button
            type="button"
            class="spine__btn"
            aria-label="切换配色"
            onClick={() => {
              const current = document.documentElement.dataset.theme
              setTheme(current === 'dark' ? 'light' : current === 'light' ? 'auto' : 'dark')
            }}
          >
            ◐
          </button>
          <a class="spine__btn" href="#/sites" aria-label="站点列表">▤</a>
          <a class="spine__btn" href="#/users" aria-label="管理员">◯</a>
        </div>
      </aside>

      <div class="main">
        <header class="topbar">
          <div class="topbar__site">
            {site ? (
              <>
                <span class="topbar__name">{site.name}</span>
                <span class="topbar__repo">{site.owner}/{site.repo} · {site.branch}</span>
              </>
            ) : (
              <span class="topbar__name">OnPaper 管理面板</span>
            )}
          </div>
          <div class="topbar__spacer" />
          <div class="topbar__status">
            <span class="muted">{health.user.email}</span>
            <span class={`mark mark--${health.user.role === 'owner' ? 'ok' : 'muted'}`}>
              {health.user.role === 'owner' ? 'owner' : 'editor'}
            </span>
          </div>
        </header>

        {/* The tab strip is always present, at the same height.
            On the pages that belong to no single site (overview, the site
            list, admins) it carries a breadcrumb instead of tabs. Without it
            those pages were 44px shorter, so every navigation between them and
            a site page shifted the whole content area up or down — which reads
            as the layout jumping. */}
        <nav class="tabs" aria-label={site ? '站点分区' : '位置'}>
          {site ? (
            TABS.map(tab => (
              <a
                key={tab.key}
                class="tab"
                href={hrefOf(tab.route(site.id))}
                aria-current={routeMatches(route, tab.key) ? 'page' : undefined}
              >
                {tab.label}
              </a>
            ))
          ) : (
            <>
              <a
                class="tab"
                href="#/"
                aria-current={route.name === 'overview' ? 'page' : undefined}
              >
                总览
              </a>
              <a
                class="tab"
                href="#/sites"
                aria-current={route.name === 'sites' ? 'page' : undefined}
              >
                站点
              </a>
              <a
                class="tab"
                href="#/users"
                aria-current={route.name === 'users' ? 'page' : undefined}
              >
                管理员
              </a>
            </>
          )}
        </nav>

        {/* The phone bar is shown on every screen inside a site, and on the
            site list itself it offers a way back to the first site — without
            it those two screens were the ones with no navigation at all. */}
        <BottomBar
          items={site ? PHONE_PRIMARY.map(tab => ({
            key: tab.key,
            label: tab.label,
            glyph: tab.glyph,
            route: tab.route(site.id),
          })) : sites.length ? PHONE_PRIMARY.map(tab => ({
            key: tab.key,
            label: tab.label,
            glyph: tab.glyph,
            route: tab.route(sites[0].id),
          })) : []}
          more={site ? PHONE_MORE.map(tab => ({
            key: tab.key,
            label: tab.label,
            glyph: tab.glyph,
            route: tab.route(site.id),
          })) : [
            { key: 'sites', label: '站点', glyph: '▤', route: { name: 'sites' } as Route },
            { key: 'users', label: '管理员', glyph: '◯', route: { name: 'users' } as Route },
          ]}
          current={site ? (TABS.find(tab => routeMatches(route, tab.key))?.key ?? '') : route.name}
        />

        <main class="content" id="content">
          <View route={route} ctx={ctx} />
        </main>
      </div>

      <ToastStack toasts={toasts} dismiss={dismiss} />
    </div>
  )
}

/**
 * The screens worth warming, in the order they are wanted.
 *
 * Posts first: it is the landing screen for a site and the biggest list. The
 * rest are the tabs on the strip. Anything that reads a single file (a post
 * editor, a media folder) is left alone — those are picked by a click that the
 * prefetch cannot predict, and guessing would spend requests for nothing.
 */
function mostlyVisited(siteId: number): string[] {
  const base = `/api/sites/${siteId}`
  return [
    `${base}/posts`,
    `${base}/tasks/meta`,
    `${base}/tasks`,
    `${base}/shelf`,
    // The page editor asks for one page at a time and opens on 关于, so warming
    // the list alone left its first visit the slowest screen in the panel.
    `${base}/pages/about`,
    `${base}/config`,
    `${base}/media/images`,
    `${base}/commits`,
  ]
}

function routeMatches(route: Route, tab: string): boolean {
  if (tab === 'posts') return route.name === 'posts' || route.name === 'post' || route.name === 'new-post'
  if (tab === 'pages') return route.name === 'pages'
  if (tab === 'shelf') return route.name === 'shelf'
  if (tab === 'config') return route.name === 'config'
  if (tab === 'media') return route.name === 'media'
  if (tab === 'tasks') return route.name === 'tasks'
  if (tab === 'history') return route.name === 'history'
  if (tab === 'audit') return route.name === 'audit'
  return false
}

function View({ route, ctx }: { route: Route, ctx: AppContext }): ComponentChildren {
  switch (route.name) {
    case 'overview':
      return <OverviewView ctx={ctx} route={route as never} />
    case 'sites':
      return <SitesView ctx={ctx} />
    case 'users':
      return <UsersView ctx={ctx} />
    case 'posts':
      return <PostsView ctx={ctx} siteId={(route as { siteId: number }).siteId} />
    case 'post':
      return <PostEditorView ctx={ctx} siteId={(route as { siteId: number }).siteId} slug={(route as { slug: string }).slug} />
    case 'new-post':
      return <PostEditorView ctx={ctx} siteId={(route as { siteId: number }).siteId} />
    case 'pages':
      return <PagesView ctx={ctx} siteId={(route as { siteId: number }).siteId} />
    case 'shelf':
      return <ShelfView ctx={ctx} siteId={(route as { siteId: number }).siteId} />
    case 'config':
      return <ConfigView ctx={ctx} siteId={(route as { siteId: number }).siteId} />
    case 'media':
      return <MediaView ctx={ctx} siteId={(route as { siteId: number }).siteId} folder={(route as { folder?: string }).folder} />
    case 'tasks':
      return <TasksView ctx={ctx} siteId={(route as { siteId: number }).siteId} />
    case 'history':
      return <HistoryView ctx={ctx} siteId={(route as { siteId: number }).siteId} />
    case 'audit':
      return <AuditView ctx={ctx} siteId={(route as { siteId: number }).siteId} />
    default:
      return <OverviewView ctx={ctx} route={route as never} />
  }
}

/** A page title that receives focus after a route change. */
export function PageHead({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ComponentChildren
}): ComponentChildren {
  return (
    <div class="pagehead">
      <div>
        <h1 class="pagehead__title" tabIndex={-1} data-view-heading>{title}</h1>
        {description && <p class="pagehead__desc">{description}</p>}
      </div>
      {actions && <div class="pagehead__actions">{actions}</div>}
    </div>
  )
}

export { navigate }
