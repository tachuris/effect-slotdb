import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    dts: true,
    format: ['esm'],
    sourcemap: true,
    unbundle: true,
    fixedExtension: false,
    deps: { neverBundle: true },
    copy: [{ from: 'src/wa-sqlite.d.ts', to: 'dist' }],
    entry: {
      index: 'src/index.ts',
      bun: 'src/bun.ts',
      wasm: 'src/wasm.ts',
      artifact: 'src/artifact.ts',
      testing: 'src/testing.ts',
    },
  },
})
