/**
 * 媒体库.
 *
 * Uploads go through the Worker as base64 in a JSON body: the platform gives a
 * Worker no streaming multipart parser worth the code, and the caps (5 MB per
 * file, 20 MB per batch) make a buffered request the right size. The server
 * checks magic bytes, pixel count and the target path; this screen checks the
 * same limits early, so a 30 MB photo is refused before it is uploaded.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api, isApiError } from '../lib/api'
import type { AppContext } from '../app'
import { PageHead } from '../app'
import { Empty, ErrorBox, useConfirm } from '../components/ui'
import { SkeletonRows } from '../components/feedback'

const FOLDERS = ['images', 'shelf', 'music', 'og'] as const
const FOLDER_LABELS: Record<string, string> = {
  images: '配图',
  shelf: '书架封面',
  music: '音乐封面',
  og: '分享图',
}
const MAX_FILE = 5 * 1024 * 1024
const MAX_BATCH = 20 * 1024 * 1024

interface MediaFile {
  name: string
  path: string
  size: number
  sha: string
  url: string
}

export function MediaView({
  ctx, siteId, folder: initialFolder,
}: {
  ctx: AppContext
  siteId: number
  folder?: string
}): ComponentChildren {
  const [folder, setFolder] = useState<string>(
    FOLDERS.includes((initialFolder ?? '') as (typeof FOLDERS)[number]) ? initialFolder! : 'images',
  )
  const [files, setFiles] = useState<MediaFile[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [confirmElement, confirm] = useConfirm()

  const load = async () => {
    setFiles(null)
    setError(null)
    try {
      const result = await api.get<{ files: MediaFile[] }>(`/api/sites/${siteId}/media/${folder}`)
      setFiles(result.files)
    }
    catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)))
    }
  }

  useEffect(() => { void load() }, [siteId, folder])

  const upload = async (list: FileList | null) => {
    if (!list?.length) return
    const chosen = [...list]

    const tooBig = chosen.find(file => file.size > MAX_FILE)
    if (tooBig) {
      ctx.toast('danger', `${tooBig.name} 超过 5 MB`)
      return
    }
    const total = chosen.reduce((sum, file) => sum + file.size, 0)
    if (total > MAX_BATCH) {
      ctx.toast('danger', '本次选择的文件总量超过 20 MB，分批上传')
      return
    }

    setBusy(true)
    try {
      const payload = await Promise.all(chosen.map(async file => ({
        name: file.name,
        data: await toBase64(file),
      })))
      const result = await api.post<{ files: Array<{ name: string }> }>(
        `/api/sites/${siteId}/media/${folder}`,
        { files: payload },
      )
      ctx.toast('ok', `上传了 ${result.files.length} 个文件`)
      await load()
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
    finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const remove = async (file: MediaFile) => {
    const refs = await api.get<{ references: Array<{ path: string, line: number, text: string }> }>(
      `/api/sites/${siteId}/media-references?path=${encodeURIComponent(file.path)}`,
    ).catch(() => ({ references: [] }))

    const ok = await confirm({
      title: `删除 ${file.name}？`,
      message: refs.references.length
        ? `${refs.references.length} 个文件还在引用它，删掉之后那些位置会变成破图：`
        : '没有文章引用这张图。',
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return

    try {
      await api.delete(`/api/sites/${siteId}/media/${folder}/${encodeURIComponent(file.name)}`)
      ctx.toast('ok', '已删除')
      await load()
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
  }

  const copyMarkdown = async (file: MediaFile) => {
    const markdown = `![${file.name.replace(/\.[^.]+$/, '')}](${file.url})`
    try {
      await navigator.clipboard.writeText(markdown)
      ctx.toast('ok', 'Markdown 已复制')
    }
    catch {
      ctx.toast('warn', `复制失败，手动复制：${markdown}`)
    }
  }

  return (
    <div class="stack">
      <PageHead
        title="媒体"
        description="public/ 下的图片。上传会直接提交到仓库。"
        actions={
          <div class="row">
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/avif"
              multiple
              class="sr-only"
              id="media-input"
              onChange={event => void upload((event.target as HTMLInputElement).files)}
            />
            <label class="btn btn--primary" for="media-input" aria-disabled={busy}>
              {busy ? '上传中…' : '上传图片'}
            </label>
          </div>
        }
      />

      <nav class="subtabs" aria-label="媒体目录">
        {FOLDERS.map(name => (
          <button key={name} type="button" class="tab" aria-current={folder === name ? 'page' : undefined} onClick={() => setFolder(name)}>
            {FOLDER_LABELS[name]}
          </button>
        ))}
      </nav>

      <p class="hint">只接受 png、jpg、webp、avif；单张 ≤ 5 MB，一次 ≤ 20 MB。SVG 不允许上传。</p>

      {error && <ErrorBox error={error} onRetry={() => { void load() }} />}
      {!error && !files && <SkeletonRows rows={4} />}
      {files && !files.length && <Empty title="这个目录还是空的">上传一张图，然后在文章里用它。</Empty>}

      {files && files.length > 0 && (
        <div class="media-grid">
          {files.map(file => (
            <figure key={file.path} class="media-card">
              <div class="media-card__frame">
                <img src={file.url} alt="" loading="lazy" decoding="async" />
              </div>
              <figcaption class="media-card__meta">
                <span class="media-card__name mono" title={file.name}>{file.name}</span>
                <span class="muted">{(file.size / 1024).toFixed(0)} KB</span>
              </figcaption>
              <div class="row media-card__actions">
                <button type="button" class="btn btn--sm btn--ghost" onClick={() => void copyMarkdown(file)}>复制</button>
                <a class="btn btn--sm btn--ghost" href={file.url} target="_blank" rel="noreferrer noopener">查看</a>
                <button type="button" class="btn btn--sm btn--danger" onClick={() => void remove(file)}>删除</button>
              </div>
            </figure>
          ))}
        </div>
      )}

      {confirmElement}
    </div>
  )
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}
