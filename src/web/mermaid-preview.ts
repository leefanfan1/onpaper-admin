/**
 * The Mermaid entry the preview frame imports.
 *
 * It is a separate bundle with a fixed output name (`mermaid-preview.js`) for
 * two reasons: Mermaid is ~500 KB and a panel page that shows no diagram should
 * not download it; and the preview frame is sandboxed, so it cannot resolve the
 * hashed asset filenames the main bundle uses — it needs one stable URL.
 *
 * `securityLevel: 'strict'` is what stops a diagram from carrying click
 * handlers or `javascript:` links into the frame.
 */

import mermaid from 'mermaid'

export interface RenderOptions {
  dark?: boolean
}

export async function renderDiagrams(options: RenderOptions = {}): Promise<void> {
  const blocks = Array.from(document.querySelectorAll<HTMLElement>('pre.mermaid'))
  if (!blocks.length) return

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: options.dark ? 'dark' : 'default',
    fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  })

  for (const block of blocks) {
    const source = block.textContent ?? ''
    const id = `d${block.dataset.diagram ?? Math.random().toString(36).slice(2)}`
    try {
      const { svg } = await mermaid.render(id, source)
      block.innerHTML = svg
    }
    catch (error) {
      block.classList.add('mermaid--error')
      const message = error instanceof Error ? error.message : '语法错误'
      block.textContent = `图表无法渲染：${message}`
    }
  }
}

// Auto-run when loaded as the frame's module script.
void renderDiagrams({
  dark: document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches),
})
