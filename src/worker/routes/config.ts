/**
 * `src/config.ts`: the theme's single configuration entry.
 *
 * Reads are structured; writes are surgical. The file is full of comments that
 * explain the colour tokens and the navigation, and a "parse, patch, stringify"
 * round trip would delete them. The editor instead replaces only the characters
 * of the values that changed (see lib/config-edit.ts), so the diff a reader sees
 * on GitHub is the change they made and nothing else.
 */

import type { Hono } from 'hono'
import type { PanelEnv } from '../middleware'
import { audit } from '../middleware'
import { getFile, putFile } from '../lib/github'
import { classifyPath, normalizePath } from '../lib/paths'
import {
  applyConfigEdits,
  colorTokenNames,
  ConfigError,
  readSiteConfig,
  replaceConfigArray,
  replaceConfigObject,
  type ConfigEdit,
} from '../lib/config-edit'
import { cacheKey, invalidateSite } from '../lib/cache'
import { authOf, handle, readJson, siteOf, targetOf, writeBudget } from './shared'
import type { Site } from '../sites'

/** Colour values the token form accepts: hex, rgb(a), hsl(a), `transparent`. */
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|transparent)$/

function configPath(site: Site): string {
  const path = normalizePath(site.paths.config)
  classifyPath(path, site.paths)
  return path
}

/** Reject edits the site's own config would not accept. */
function validateConfigEdits(edits: ConfigEdit[], colorTokens: string[]): void {
  for (const edit of edits) {
    const key = edit.path[edit.path.length - 1]
    const parent = edit.path.slice(0, -1).join('.')

    if (typeof edit.value === 'string' && edit.value.length > 500) {
      throw new ConfigError('CONFIG_VALUE', `${edit.path.join('.')} 的值过长`)
    }
    if (key === 'url' || key === 'href') {
      const value = String(edit.value)
      if (value && !/^(\/|https?:\/\/|mailto:)/.test(value)) {
        throw new ConfigError('CONFIG_VALUE', `${key} 必须是以 / 开头的站内路径，或 http(s)、mailto 链接`)
      }
      if (key === 'url' && value && !value.startsWith('https://')) {
        throw new ConfigError('CONFIG_VALUE', '站点 url 必须是 https://')
      }
    }
    if (parent === 'theme.light' || parent === 'theme.dark') {
      if (typeof edit.value !== 'string' || !COLOR_RE.test(edit.value)) {
        throw new ConfigError('CONFIG_COLOR', `${key} 不是合法的色值`)
      }
    }
    if (key === 'postsPerPage') {
      const value = Number(edit.value)
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new ConfigError('CONFIG_VALUE', 'postsPerPage 必须是 1 到 100 的整数')
      }
    }
    if (key === 'startYear') {
      const value = Number(edit.value)
      if (!Number.isInteger(value) || value < 1990 || value > 2100) {
        throw new ConfigError('CONFIG_VALUE', 'startYear 不在合理范围内')
      }
    }
    if (key === 'googleAnalyticsId') {
      const value = String(edit.value)
      if (value && !/^(G-[A-Z0-9]{6,}|UA-\d+-\d+|GTM-[A-Z0-9]+)$/.test(value)) {
        throw new ConfigError('CONFIG_VALUE', 'GA 测量 ID 格式不对（例如 G-XXXXXXXXXX）')
      }
    }
    if (key === 'defaultMode') {
      if (!['auto', 'light', 'dark'].includes(String(edit.value))) {
        throw new ConfigError('CONFIG_VALUE', 'defaultMode 只能是 auto / light / dark')
      }
    }
    void colorTokens
  }
}

export function registerConfigRoutes(api: Hono<PanelEnv>): void {
  api.get('/sites/:siteId/config', async (c) => {
    try {
      const site = await siteOf(c)
      const readCacheKey = cacheKey(site.id, site.branch, 'config')
      const hit = await c.env.CACHE.get(readCacheKey, 'json').catch(() => null)
      if (hit) return c.json(hit as Record<string, unknown>)

      const target = await targetOf(c, site)
      const file = await getFile(target, configPath(site))
      if (!('content' in file)) throw new Error('不是一个文件')
      const config = readSiteConfig(file.content)
      const payload = {
        sha: file.sha,
        path: file.path,
        config,
        colorTokens: colorTokenNames(file.content),
        raw: file.content,
      }
      await c.env.CACHE.put(readCacheKey, JSON.stringify(payload), { expirationTtl: 120 }).catch(() => {})
      return c.json(payload)
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /**
   * Apply a set of value changes.
   *
   * The body is a list of `{ path, value }` edits, not a whole config object:
   * sending the whole object would lose the author's formatting for every key
   * they did not touch, and would overwrite a change made elsewhere.
   */
  api.put('/sites/:siteId/config', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const body = await readJson<{
        sha: string
        edits: ConfigEdit[]
        arrays?: Array<{ key: string, items: Array<Record<string, string | boolean>> }>
        objects?: Array<{ path: string[], values: Record<string, string | number | boolean> }>
      }>(c)

      const target = await targetOf(c, site)
      const path = configPath(site)
      const current = await getFile(target, path)
      if (!('content' in current)) throw new Error('不是一个文件')
      if (body.sha && body.sha !== current.sha) {
        return c.json({ error: '配置文件在此期间被修改过，请刷新后再保存', code: 'CONFLICT' }, 409)
      }

      const tokens = colorTokenNames(current.content)
      let text = current.content
      const applied: string[] = []

      // Arrays and objects first: they change the text length, which would
      // invalidate the offsets the scalar edits were computed against. Each is
      // applied to the result of the last.
      for (const array of body.arrays ?? []) {
        text = replaceConfigArray(text, array.key, array.items)
        applied.push(array.key)
      }
      for (const object of body.objects ?? []) {
        text = replaceConfigObject(text, object.path, object.values)
        applied.push(object.path.join('.'))
      }
      if (body.edits?.length) {
        validateConfigEdits(body.edits, tokens)
        const result = applyConfigEdits(text, body.edits)
        text = result.text
        applied.push(...result.applied.map(parts => parts.join('.')))
      }

      if (text === current.content) {
        return c.json({ ok: true, unchanged: true, sha: current.sha })
      }

      // Prove the result still parses and reads back before committing it.
      readSiteConfig(text)

      const result = await putFile(target, path, text, current.sha, 'chore: 更新站点配置')
      await invalidateSite(c.env, site.id, site.branch)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'config.update',
        target: path,
        detail: { applied },
        commit: result.commit,
      })
      return c.json({ ok: true, sha: result.sha, commit: result.commit, applied })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /** Raw source for the "edit the file directly" escape hatch. */
  api.put('/sites/:siteId/config/raw', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const body = await readJson<{ sha: string, content: string }>(c, 500_000)
      const target = await targetOf(c, site)
      const path = configPath(site)
      const current = await getFile(target, path)
      if (!('content' in current)) throw new Error('不是一个文件')
      if (body.sha && body.sha !== current.sha) {
        return c.json({ error: '配置文件在此期间被修改过，请刷新后再保存', code: 'CONFLICT' }, 409)
      }

      // The same structural check the form path runs: a file that does not
      // parse is a site that does not build.
      const config = readSiteConfig(String(body.content ?? ''))
      if (!config.title) throw new ConfigError('CONFIG_SHAPE', '修改后的配置读不出站点标题')

      const result = await putFile(target, path, body.content, current.sha, 'chore: 手动修改站点配置')
      await invalidateSite(c.env, site.id, site.branch)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'config.raw',
        target: path,
        commit: result.commit,
      })
      return c.json({ ok: true, sha: result.sha, commit: result.commit })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /** The OG template, as text. SVG is refused as an upload; editing it here is the one path. */
  api.get('/sites/:siteId/og-source', async (c) => {
    try {
      const site = await siteOf(c)
      const target = await targetOf(c, site)
      const file = await getFile(target, `${normalizePath(site.paths.public)}/og.svg`)
      if (!('content' in file)) throw new Error('不是一个文件')
      return c.json({ sha: file.sha, content: file.content })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.put('/sites/:siteId/og-source', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const body = await readJson<{ sha: string, content: string }>(c, 1_000_000)
      const content = String(body.content ?? '')

      // An SVG can carry script. This one is rendered by a build step into a
      // PNG, but it is also served as a file, so the same rules apply as for
      // an upload: no <script>, no event handlers, no external references.
      if (/<\s*script/i.test(content) || /\son\w+\s*=/i.test(content)) {
        return c.json({ error: 'OG 模板里不能有 script 或事件属性', code: 'SVG_SCRIPT' }, 400)
      }
      if (/<\s*foreignObject/i.test(content)) {
        return c.json({ error: 'OG 模板里不能有 foreignObject', code: 'SVG_FOREIGN' }, 400)
      }
      if (/(href|src)\s*=\s*["']?\s*javascript:/i.test(content)) {
        return c.json({ error: 'OG 模板里不能有 javascript: 链接', code: 'SVG_JS_URL' }, 400)
      }

      const target = await targetOf(c, site)
      const path = `${normalizePath(site.paths.public)}/og.svg`
      classifyPath(path, site.paths)
      const current = await getFile(target, path)
      if (!('content' in current)) throw new Error('不是一个文件')
      if (body.sha && body.sha !== current.sha) {
        return c.json({ error: '文件在此期间被修改过，请刷新后再保存', code: 'CONFLICT' }, 409)
      }

      const result = await putFile(target, path, content, current.sha, 'chore: 更新 OG 模板')
      await invalidateSite(c.env, site.id, site.branch)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'og.source',
        target: path,
        commit: result.commit,
      })
      return c.json({ ok: true, sha: result.sha, commit: result.commit })
    }
    catch (error) {
      return handle(c, error)
    }
  })
}
