/** How every line-oriented module in this project splits text. */
export const SPLIT_LINES = (text: string): string[] => text.split(/\r?\n/)

export function lineDiff(before: string, after: string): {
  lines: Array<{ kind: 'same' | 'add' | 'remove', text: string }>
  added: number
  removed: number
  truncated: boolean
} {
  const a = SPLIT_LINES(before)
  const b = SPLIT_LINES(after)
  const LIMIT = 1200
  if (a.length > LIMIT || b.length > LIMIT) {
    return {
      lines: [{ kind: 'same', text: '（文件过长，这里只判断内容是否相同）' }],
      added: 0,
      removed: 0,
      truncated: true,
    }
  }

  // LCS lengths, filled bottom-up.
  const table: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const lines: Array<{ kind: 'same' | 'add' | 'remove', text: string }> = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] }); i++; j++
    }
    else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: 'remove', text: a[i] }); removed++; i++
    }
    else {
      lines.push({ kind: 'add', text: b[j] }); added++; j++
    }
  }
  while (i < a.length) { lines.push({ kind: 'remove', text: a[i++] }); removed++ }
  while (j < b.length) { lines.push({ kind: 'add', text: b[j++] }); added++ }

  return { lines, added, removed, truncated: false }
}
