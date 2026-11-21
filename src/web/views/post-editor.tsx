/**
 * The post editor.
 *
 * Two panes on a wide screen: the Markdown source and a preview rendered the
 * way the site will render it. The panes are separate scroll areas because
 * scrolling one should not drag the other; on a narrow screen they become tabs,
 * which is the honest adaptation of "can't see both" rather than squeezing two
 * columns into 390px.
 *
 * The preview is sanitised and rendered inside a sandboxed frame. A preview is
 * a place where content that has not been reviewed yet becomes HTML — exactly
 * where an XSS would be most welcome — so it gets no script and no same-origin.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { EditorView, basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { api, isApiError, type PostDetail } from '../lib/api'
import type { AppContext } from '../app'
import { PageHead } from '../app'
import { navigate } from '../lib/router'
import { ErrorBox, formatDate, useConfirm } from '../components/ui'
import { SkeletonRows } from '../components/feedback'
import { useT } from '../lib/i18n'
import { DiffPreview } from '../components/diff'
import { parseFrontmatterFile } from '../lib/import-post'
import { renderMarkdown } from '../lib/markdown'

interface Draft {
  title: string
  description: string
  published: string
  updated: string
  tags: string
  pin: number
  draft: boolean
  /** '' when the file has no `lang` line — an older theme's schema has no such key. */
  lang: string
  slug: string
}

export function PostEditorView({
  ctx,
  siteId,
  slug,
}: {
  ctx: AppContext
  siteId: number
  slug?: string
}): ComponentChildren {
  const { t } = useT()
  const isNew = !slug
  const [detail, setDetail] = useState<PostDetail | null>(null)
  const [draft, setDraft] = useState<Draft>({
    title: '', description: '', published: formatDate(new Date().toISOString()),
    updated: '', tags: '', pin: 0, draft: false, lang: '', slug: '',
  })
  const [body, setBody] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [pane, setPane] = useState<'write' | 'preview'>('write')
  const [confirmElement, confirm] = useConfirm()
  const editorHost = useRef<HTMLDivElement>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    if (isNew) {
      setDetail(null)
      setDraft(current => ({ ...current, slug: '', title: '', description: '', published: formatDate(new Date().toISOString()) }))
      setBody(`${t('editor.bodyPlaceholder')}\n`)
      setDirty(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const result = await api.get<PostDetail>(`/api/sites/${siteId}/posts/${encodeURIComponent(slug)}`)
        if (cancelled) return
        setDetail(result)
        setDraft({
          title: result.frontmatter.title,
          description: result.frontmatter.description,
          published: result.frontmatter.published,
          updated: result.frontmatter.updated ?? '',
          tags: result.frontmatter.tags.join(', '),
          pin: result.frontmatter.pin,
          draft: result.frontmatter.draft,
          lang: result.frontmatter.lang ?? '',
          slug: result.slug,
        })
        setBody(result.body)
        setDirty(false)
      }
      catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught : new Error(String(caught)))
      }
    })()
    return () => { cancelled = true }
  }, [siteId, slug, isNew])

  // CodeMirror owns its DOM node. The React-style diff must not manage children
  // inside it, so the node is created once per file and disposed on unmount.
  useEffect(() => {
    const host = editorHost.current
    if (!host) return
    const view = new EditorView({
      doc: body,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setBody(update.state.doc.toString())
            setDirty(true)
          }
        }),
        EditorView.theme({
          '&': { fontSize: '14px', backgroundColor: 'transparent' },
          '.cm-content': { fontFamily: 'var(--font-mono)', padding: '12px 0' },
          '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--ink-faint)' },
          '.cm-activeLine': { backgroundColor: 'var(--surface)' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    })
    host.appendChild(view.dom)
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Recreating on every body change would reset the cursor; this runs once per
    // loaded file, keyed by slug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, detail?.sha])

  const preview = useMemo(() => renderMarkdown(body), [body])

  /**
   * Save, but show the diff first.
   *
   * The panel writes to a real site, and a wrong write is not something a
   * confirmation dialog protects against — a person can only meaningfully
   * approve a change they can see. So the editor asks the server to render the
   * file the save would produce, shows the line diff, and only then commits.
   * The commit itself re-checks the sha, so a change made in between is still
   * refused rather than overwritten.
   */
  const save = async () => {
    setSaving(true)
    try {
      const payload = {
        frontmatter: {
          title: draft.title,
          description: draft.description,
          published: draft.published,
          ...(draft.updated ? { updated: draft.updated } : {}),
          tags: draft.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
          pin: draft.pin,
          draft: draft.draft,
          // Only when the file already has the line: an older theme's schema
          // would reject a `lang` key, so an empty choice means "leave it".
          ...(draft.lang ? { lang: draft.lang } : {}),
        },
        body,
        ...(detail?.extra ? { extra: detail.extra } : {}),
      }

      if (isNew) {
        const result = await api.post<{ slug: string }>(`/api/sites/${siteId}/posts`, {
          slug: draft.slug,
          title: draft.title,
          description: draft.description,
          tags: payload.frontmatter.tags,
          pin: draft.pin,
          draft: draft.draft,
        })
        // The server lowercases the slug (a post's URL is lowercase by the
        // site's own rule). Say so when that changed what was typed, rather
        // than leaving the author to discover it from the address bar.
        if (draft.slug && draft.slug !== result.slug) {
          ctx.toast('ok', t('editor.createdSlug', result.slug))
        }
        else {
          ctx.toast('ok', t('editor.created'))
        }
        navigate({ name: 'post', siteId, slug: result.slug })
        return
      }

      if (!detail) return

      const nextSlug = draft.slug && draft.slug !== detail.slug ? draft.slug : undefined

      // 1. Render the change and show it.
      let preview: {
        path: string
        renamed: boolean
        diff: { lines: Array<{ kind: 'same' | 'add' | 'remove', text: string }>, added: number, removed: number, truncated: boolean }
      }
      try {
        preview = await api.post(`/api/sites/${siteId}/posts/${encodeURIComponent(detail.slug)}/preview`, {
          ...payload,
          ...(nextSlug ? { newSlug: nextSlug } : {}),
        })
      }
      catch (caught) {
        ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
        return
      }

      if (!preview.diff.added && !preview.diff.removed) {
        ctx.toast('info', t('editor.noChange'))
        setDirty(false)
        return
      }

      const approved = await confirm({
        title: t('editor.saveTitle', preview.diff.added, preview.diff.removed),
        message: <DiffPreview diff={preview.diff} renamed={preview.renamed} path={preview.path} />,
        confirmLabel: t('editor.confirmSave'),
        cancelLabel: t('editor.lookAgain'),
      })
      if (!approved) return

      // 2. Commit, with the sha the preview was built from.
      const result = await api.put<{ slug: string, sha: string }>(
        `/api/sites/${siteId}/posts/${encodeURIComponent(detail.slug)}`,
        {
          sha: detail.sha,
          ...payload,
          ...(nextSlug ? { newSlug: nextSlug } : {}),
        },
      )
      setDetail({ ...detail, sha: result.sha, slug: result.slug })
      setDraft(current => ({ ...current, slug: result.slug }))
      setDirty(false)
      ctx.toast('ok', t('editor.saved'))
      if (result.slug !== detail.slug) navigate({ name: 'post', siteId, slug: result.slug })
    }
    catch (caught) {
      if (isApiError(caught) && caught.code === 'CONFLICT') {
        ctx.toast('danger', t('editor.conflict'))
      }
      else {
        ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
      }
    }
    finally {
      setSaving(false)
    }
  }

  /**
   * Load a Markdown file into the editor.
   *
   * The file is parsed here rather than sent to the server: the author should
   * see the title, date and tags the panel read, correct anything missing, and
   * then create the post deliberately. A file whose front matter cannot be read
   * still loads its body, so nothing is lost — the author can fill the fields in
   * by hand.
   */
  const loadFromFile = async (list: FileList | null) => {
    const file = list?.[0]
    if (!file) return
    if (!/\.(md|markdown|mdx)$/i.test(file.name)) {
      ctx.toast('warn', t('posts.mdOnly'))
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      ctx.toast('danger', t('posts.tooBig', file.name))
      return
    }

    const text = await file.text()
    const parsed = parseFrontmatterFile(text, file.name)

    setDraft({
      title: parsed.frontmatter.title,
      description: parsed.frontmatter.description,
      published: parsed.frontmatter.published || formatDate(new Date().toISOString()),
      updated: parsed.frontmatter.updated ?? '',
      tags: parsed.frontmatter.tags.join(', '),
      pin: parsed.frontmatter.pin,
      draft: parsed.frontmatter.draft,
      lang: parsed.frontmatter.lang ?? '',
      slug: parsed.slug,
    })
    setBody(parsed.body)
    setDirty(true)
    if (parsed.warning) ctx.toast('warn', parsed.warning)
    else ctx.toast('ok', t('editor.loaded', parsed.frontmatter.title || file.name))
    if (importInput.current) importInput.current.value = ''
  }

  const remove = async () => {
    if (!detail) return
    const ok = await confirm({
      title: t('editor.deleteTitle', detail.frontmatter.title),
      message: t('editor.deleteBody'),
      confirmLabel: t('common.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.delete(`/api/sites/${siteId}/posts/${encodeURIComponent(detail.slug)}?sha=${detail.sha}`)
      ctx.toast('ok', t('editor.deleted'))
      navigate({ name: 'posts', siteId })
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
  }

  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  /*
   * The head is drawn before the file arrives.
   *
   * Returning a bare loading line made this page start 120px higher and drop
   * when the post arrived — the same jump the list pages had. The heading, the
   * description and the actions are known from the route alone, so they are
   * not made to wait for GitHub.
   */
  if (error) return <ErrorBox error={error} />
  if (!isNew && !detail) {
    return (
      <div class="stack">
        <PageHead title={t('editor.edit')} description={t('editor.opening')} />
        <SkeletonRows rows={6} />
      </div>
    )
  }

  return (
    <div class="stack">
      <PageHead
        title={isNew ? t('editor.new') : t('editor.edit')}
        description={
          isNew
            ? t('editor.newHint')
            : detail ? t('editor.meta', detail.slug, detail.words, detail.minutes) : undefined
        }
        actions={
          <div class="row">
            {isNew && (
              <>
                {/* Import a file into this editor rather than straight into the
                    repo: the author sees what was read, can fix a missing front
                    matter field, and then creates it deliberately. */}
                <input
                  ref={importInput}
                  type="file"
                  accept=".md,.markdown,.mdx,text/markdown"
                  class="sr-only"
                  id="md-into-editor"
                  onChange={event => void loadFromFile((event.target as HTMLInputElement).files)}
                />
                <label class="btn" for="md-into-editor">{t('editor.writeMd')}</label>
              </>
            )}
            {!isNew && (
              <>
                {/* Download is a link, not a fetch-and-blob: the server sets
                    Content-Disposition, so the browser saves the file directly. */}
                <a
                  class="btn"
                  href={`/api/sites/${siteId}/posts/${encodeURIComponent(detail?.slug ?? '')}/download`}
                  download={`${detail?.slug ?? 'post'}.md`}
                >
                  {t('editor.download')}
                </a>
                <button type="button" class="btn btn--danger" onClick={() => void remove()}>{t('common.delete')}</button>
              </>
            )}
            <button type="button" class="btn btn--primary" disabled={saving} onClick={() => void save()}>
              {saving ? t('common.saving') : isNew ? t('editor.create') : t('editor.checkAndSave')}
            </button>
          </div>
        }
      />

      <div class="meta-grid">
        {isNew && (
          <label class="field">
            <span class="label">{t('editor.slugField')}</span>
            <input
              class="input mono"
              value={draft.slug}
              placeholder="my-new-post"
              aria-describedby="slug-hint"
              onInput={event => {
                setDraft(current => ({ ...current, slug: (event.target as HTMLInputElement).value }))
                setDirty(true)
              }}
            />
            <span class="hint" id="slug-hint">{t('editor.slugFieldHint')}</span>
          </label>
        )}
        <label class="field">
          <span class="label">{t('editor.titleField')}</span>
          <input
            class="input"
            value={draft.title}
            onInput={event => {
              setDraft(current => ({ ...current, title: (event.target as HTMLInputElement).value }))
              setDirty(true)
            }}
          />
        </label>
        <label class="field">
          <span class="label">{t('editor.published')}</span>
          <input
            class="input"
            type="date"
            value={draft.published}
            onInput={event => {
              setDraft(current => ({ ...current, published: (event.target as HTMLInputElement).value }))
              setDirty(true)
            }}
          />
        </label>
        <label class="field meta-grid__wide">
          <span class="label">{t('editor.descriptionField')}</span>
          <input
            class="input"
            value={draft.description}
            placeholder={t('editor.descriptionPlaceholder')}
            onInput={event => {
              setDraft(current => ({ ...current, description: (event.target as HTMLInputElement).value }))
              setDirty(true)
            }}
          />
        </label>
        <label class="field">
          <span class="label">{t('editor.tags')}</span>
          <input
            class="input"
            value={draft.tags}
            placeholder={t('editor.tagsPlaceholder')}
            onInput={event => {
              setDraft(current => ({ ...current, tags: (event.target as HTMLInputElement).value }))
              setDirty(true)
            }}
          />
        </label>
        <label class="field">
          <span class="label">{t('editor.pin')}</span>
          <input
            class="input"
            type="number"
            min={0}
            max={99}
            value={draft.pin}
            onInput={event => {
              setDraft(current => ({ ...current, pin: Number((event.target as HTMLInputElement).value) || 0 }))
              setDirty(true)
            }}
          />
        </label>
        {/*
          The post's own language. Only shown when the file has the line: an
          older theme's schema has no `lang` key, and offering a control that
          would write one there would break the build.
        */}
        {draft.lang !== '' && (
          <label class="field">
            <span class="label">{t('editor.lang')}</span>
            <select
              class="select"
              aria-label={t('editor.lang')}
              value={draft.lang}
              onChange={event => {
                setDraft(current => ({ ...current, lang: (event.target as HTMLSelectElement).value }))
                setDirty(true)
              }}
            >
              <option value="zh">{t('editor.langZh')}</option>
              <option value="en">{t('editor.langEn')}</option>
            </select>
            <span class="hint">{t('editor.langHint')}</span>
          </label>
        )}
        <label class="field meta-grid__check">
          <span class="label">
            <input
              type="checkbox"
              checked={draft.draft}
              onChange={event => {
                setDraft(current => ({ ...current, draft: (event.target as HTMLInputElement).checked }))
                setDirty(true)
              }}
            />{' '}
            {t('editor.draft')}
          </span>
          <span class="hint">{t('editor.draftHint')}</span>
        </label>
        {!isNew && (
          <label class="field">
            <span class="label">{t('editor.slug')}</span>
            <input
              class="input mono"
              value={draft.slug}
              onInput={event => {
                setDraft(current => ({ ...current, slug: (event.target as HTMLInputElement).value }))
                setDirty(true)
              }}
            />
            <span class="hint">{t('editor.slugHint')}</span>
          </label>
        )}
      </div>

      <div class="editor" data-pane={pane}>
        <div class="editor__tabs" role="tablist" aria-label={t('editor.paneAria')}>
          <button
            type="button"
            role="tab"
            class="tab"
            aria-selected={pane === 'write'}
            onClick={() => setPane('write')}
          >
            {t('editor.paneWrite')}
          </button>
          <button
            type="button"
            role="tab"
            class="tab"
            aria-selected={pane === 'preview'}
            onClick={() => setPane('preview')}
          >
            {t('editor.panePreview')}
          </button>
          <span class="editor__spacer" />
          {dirty && <span class="mark mark--warn">{t('editor.unsaved')}</span>}
        </div>

        <div class="editor__panes">
          <div class="editor__pane editor__pane--write" ref={editorHost} />
          <div class="editor__pane editor__pane--preview">
            <iframe
              class="preview-frame"
              title={t('editor.previewTitle')}
              /*
                `allow-scripts` without `allow-same-origin`: the frame needs to
                run Mermaid to draw a diagram, and that one attribute is what
                lets it. It is safe only because the second attribute is absent
                — together they would let the frame reach into the panel, which
                is the classic sandbox escape. Mermaid itself runs at
                `securityLevel: 'strict'`, and the HTML is sanitised first.
              */
              sandbox="allow-scripts"
              srcdoc={preview}
            />
          </div>
        </div>
      </div>

      {confirmElement}
    </div>
  )
}
