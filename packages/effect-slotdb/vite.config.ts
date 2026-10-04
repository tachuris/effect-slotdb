import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    dts: true,
    format: ['esm'],
    sourcemap: true,
    unbundle: true,
    fixedExtension: false,
    deps: { neverBundle: true },
    entry: {
      index: 'src/index.ts',
      migration: 'src/migration/index.ts',
      replication: 'src/replication/index.ts',
      changes: 'src/changes/index.ts',
      records: 'src/records/index.ts',
      artifact: 'src/artifact.ts',
      testing: 'src/testing.ts',
    },
  },
})
