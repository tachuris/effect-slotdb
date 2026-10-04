import { defineConfig } from 'vite'

export default defineConfig({
  // Exclude wa-sqlite from prebundling so import.meta.url resolves its sibling wasm file.
  optimizeDeps: {
    exclude: ['wa-sqlite'],
  },
})
