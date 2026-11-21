const MERMAID_FENCE = new RegExp(
  // ```mermaid, a newline, the source, and a closing fence at the same indent.
  // Built from a string so the backslashes are not at the mercy of an editor.
  '^```mermaid[ \\t]*\\r?\\n([\\s\\S]*?)^```[ \\t]*$',
  'gm',
)

function extractMermaid(markdownText: string): { markdown: string, diagrams: string[] } {
  const diagrams: string[] = []
  const markdown = markdownText.replace(MERMAID_FENCE, (_match, source: string) => {
    const index = diagrams.push(String(source).trimEnd()) - 1
    // A placeholder element survives Markdown escaping and is replaced once the
    // sanitised HTML exists.
    return `<pre class="mermaid" data-diagram="${index}"></pre>`
  })
  return { markdown, diagrams }
}

export { extractMermaid }
