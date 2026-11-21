/**
 * The diff a save would make.
 *
 * Shown inside the confirmation dialog, because a person cannot approve a
 * change they cannot see — and this panel writes to a live site. Long diffs are
 * collapsed around the changes rather than shown whole: the lines that did not
 * change are context, and 500 of them bury the ten that matter.
 */

import type { ComponentChildren } from 'preact'

export interface DiffLine {
  kind: 'same' | 'add' | 'remove'
  text: string
}

export interface Diff {
  lines: DiffLine[]
  added: number
  removed: number
  truncated: boolean
}

/** How much unchanged text to keep on each side of a change. */
const CONTEXT = 3

/**
 * Keep the changed lines and a little context around each.
 *
 * A run of unchanged lines longer than `CONTEXT * 2 + 1` becomes one elision
 * marker, which is what makes a 600-line file's one-paragraph edit legible.
 */
function collapse(lines: DiffLine[]): Array<DiffLine | { kind: 'gap', count: number }> {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === 'same') return
    for (let i = Math.max(0, index - CONTEXT); i <= Math.min(lines.length - 1, index + CONTEXT); i++) {
      keep[i] = true
    }
  })

  const out: Array<DiffLine | { kind: 'gap', count: number }> = []
  let gap = 0
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (gap) { out.push({ kind: 'gap', count: gap }); gap = 0 }
      out.push(line)
    }
    else {
      gap++
    }
  })
  if (gap) out.push({ kind: 'gap', count: gap })
  return out
}

export function DiffPreview({ diff, renamed, path }: {
  diff: Diff
  renamed?: boolean
  path?: string
}): ComponentChildren {
  if (diff.truncated) {
    return (
      <p class="diff__note">
        文件较大，这里只确认内容有变化。{path && <span class="mono">{path}</span>}
      </p>
    )
  }

  // A whole-file replace is usually a rename or a rewrite; collapsing it would
  // show nothing useful, so it is shown as-is up to a cap.
  const wholeFileChanged = diff.added > 0 && diff.removed > 0
    && diff.lines.every(line => line.kind !== 'same')
  const visible: Array<DiffLine | { kind: 'gap', count: number }> = wholeFileChanged
    ? diff.lines.slice(0, 80)
    : collapse(diff.lines)

  return (
    <div class="diff">
      {renamed && path && (
        <p class="diff__note">
          文件会被移动到 <span class="mono">{path}</span>（同一个提交里完成）
        </p>
      )}
      <ol class="diff__lines" role="list">
        {visible.map((line, index) => (
          line.kind === 'gap' ? (
            <li key={index} class="diff__gap" aria-label={`省略 ${line.count} 行未变的内容`}>
              ⋯ {line.count} 行未变
            </li>
          ) : (
            <li key={index} class={`diff__line diff__line--${line.kind}`}>
              <span class="diff__sign" aria-hidden="true">
                {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
              </span>
              <span class="diff__text">{line.text || ' '}</span>
              <span class="sr-only">
                {line.kind === 'add' ? '新增' : line.kind === 'remove' ? '删除' : '未变'}
              </span>
            </li>
          )
        ))}
        {wholeFileChanged && diff.lines.length > 80 && (
          <li class="diff__gap">⋯ 还有 {diff.lines.length - 80} 行</li>
        )}
      </ol>
    </div>
  )
}
