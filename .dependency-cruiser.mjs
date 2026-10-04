/**
 * Dependency rules for workspace packages and SQL modules.
 * Run `vp run arch` to check allowed imports.
 */

/** Forbid workspace-internal targets outside the allowlist. */
const ring = (name, pkg, allowed, comment) => ({
  name,
  severity: 'error',
  comment,
  from: { path: `^packages/${pkg}/src` },
  to: { path: '^(packages|examples)/', pathNot: `^packages/(${allowed.join('|')})/` },
})

export default {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },

    // Allowed workspace dependencies.
    ring(
      'ring-effect-slotdb',
      'effect-slotdb',
      ['effect-slotdb'],
      'effect-slotdb may import only its own workspace modules.',
    ),
    ring(
      'ring-effect-slotdb-sqlite',
      'effect-slotdb-sqlite',
      ['effect-slotdb-sqlite', 'effect-slotdb'],
      'effect-slotdb-sqlite may import its own modules and effect-slotdb.',
    ),
    // Examples may import both packages.

    // SQL dependencies must be confined to sql directories.
    {
      name: 'effect-slotdb-tier-sql-free',
      severity: 'error',
      comment:
        'Keep SQL dependencies in migration/sql and replication/sql. Entry point modules and tests are exempt.',
      from: {
        path: '^packages/effect-slotdb/src/(migration|replication|migration)/[^/]+\\.ts$',
        pathNot: 'index\\.ts$|\\.test\\.ts$',
      },
      to: { path: 'effect/dist/sql' },
    },
    {
      name: 'effect-slotdb-records-tier-sql-free',
      severity: 'error',
      comment: 'Keep SQL dependencies in records/sql. Entry point modules and tests are exempt.',
      from: {
        path: '^packages/effect-slotdb/src/records/[^/]+\\.ts$',
        pathNot: 'index\\.ts$|\\.test\\.ts$',
      },
      to: { path: 'effect/dist/sql' },
    },
    {
      name: 'effect-slotdb-migration-changes-free',
      severity: 'error',
      comment:
        'Migration modules must not import changes modules. Tests and entry point modules are exempt.',
      from: {
        path: '^packages/effect-slotdb/src/migration/',
        pathNot: 'index\\.ts$|\\.test\\.ts$',
      },
      to: { path: '^packages/effect-slotdb/src/changes/' },
    },
    {
      name: 'effect-slotdb-migration-replication-free',
      severity: 'error',
      comment:
        'Migration modules must not import replication modules. Tests and entry point modules are exempt.',
      from: {
        path: '^packages/effect-slotdb/src/migration/',
        pathNot: 'index\\.ts$|\\.test\\.ts$',
      },
      to: { path: '^packages/effect-slotdb/src/replication/' },
    },

    // Browser imports must exclude platform specific dependencies.
    {
      name: 'browser-safe-kernel',
      severity: 'error',
      comment:
        'Browser modules must not import platform or driver dependencies. Keep filesystem access in artifact entry points.',
      from: {
        path: '^packages/(effect-slotdb|effect-slotdb-sqlite)/src|^examples/web/src',
        pathNot:
          '\\.test\\.ts$|^packages/effect-slotdb/src/artifact\\.ts$|' +
          '^packages/effect-slotdb-sqlite/src/(testing|artifact|bun|wasm)\\.ts$',
      },
      to: { path: '^(node:|bun:)|sql-sqlite-|platform-' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'default', 'types'],
    },
  },
}
