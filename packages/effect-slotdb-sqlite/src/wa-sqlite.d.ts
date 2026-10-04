/**
 * Ambient declarations for wa-sqlite VFS modules without bundled types. Keep imports and
 * exports inside declarations so this file declares modules rather than augments untyped
 * modules.
 */

declare module 'wa-sqlite/src/examples/OPFSAnyContextVFS.js' {
  /** OPFS-backed VFS over the async OPFS APIs, usable in any browser context. */
  export class OPFSAnyContextVFS {
    static create(name: string, module: unknown, options?: unknown): Promise<SQLiteVFS>
  }
}

declare module 'wa-sqlite/src/examples/MemoryAsyncVFS.js' {
  /** In-memory VFS for asynchronous WebAssembly builds. */
  export class MemoryAsyncVFS {
    static create(name: string, module: unknown): Promise<SQLiteVFS>
  }
}
