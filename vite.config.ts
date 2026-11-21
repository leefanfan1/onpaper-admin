import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

/**
 * The panel's own build.
 *
 * `root` is `src/web` and the output goes to `dist/web`, which is what
 * `wrangler.jsonc` serves as static assets. Everything is bundled — no CDN, no
 * runtime fetch of libraries — for the same reason the theme bundles its own
 * CSS: the panel has to work where the site works.
 */
export default defineConfig({
  root: 'src/web',
  plugins: [preact()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // The preview frame needs one stable URL for Mermaid (it is sandboxed, so
      // it cannot resolve hashed asset names), and a panel page that shows no
      // diagram should not download it. A second entry gives both.
      input: {
        main: 'src/web/index.html',
        'mermaid-preview': 'src/web/mermaid-preview.ts',
      },
      output: {
        entryFileNames: chunk => (chunk.name === 'mermaid-preview' ? 'mermaid-preview.js' : 'assets/[name]-[hash].js'),
        // Mermaid splits into dynamic chunks (cytoscape, diagram types) that the
        // sandboxed preview frame imports by their emitted URL. Hashed names
        // work — the frame resolves them relative to itself — so only the
        // entry needs pinning; chunk names keep Mermaid's own laziness intact.
        chunkFileNames: 'assets/[name]-[hash].js',
        // CodeMirror is the largest dependency and only the editor needs it;
        // keeping it separate means the list views load without it.
        manualChunks: {
          editor: ['@codemirror/state', '@codemirror/view', '@codemirror/lang-markdown', '@codemirror/commands', '@codemirror/language'],
          markdown: ['marked', 'dompurify'],
        },
      },
    },
  },
  resolve: {
    // The `codemirror` meta-package's exports map only carries `import` and
    // `require`, and Vite's deep-import check refuses a path into it. Pointing
    // the alias at the concrete file avoids the exports-map lookup entirely.
    alias: [
      { find: /^codemirror$/, replacement: new URL('./node_modules/codemirror/dist/index.js', import.meta.url).pathname },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      // `npm run dev:web` talks to `wrangler dev` on 8787.
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
})
