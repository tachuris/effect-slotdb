import * as WaSqlite from 'wa-sqlite'
import SQLiteAsyncESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs'
import { MemoryAsyncVFS } from 'wa-sqlite/src/examples/MemoryAsyncVFS.js'
import { OPFSAnyContextVFS } from 'wa-sqlite/src/examples/OPFSAnyContextVFS.js'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { identity } from 'effect/Function'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import { Reactivity } from 'effect/reactivity'
import { SqlClient, SqlConnection, SqlError, Statement } from 'effect/sql'

// Use the asyncify build with asynchronous OPFS and memory VFS implementations.
// Async OPFS supports contexts without synchronous access handles, including shared
// workers.

interface WasmClientOptions {
  readonly vfs: 'opfs' | 'memory'
  /** Database path. OPFS interprets it as a path inside the origin's bucket. */
  readonly filename: string
  /**
   * The registered VFS name prefix. Applications sharing a page need distinct prefixes.
   * `filename` determines the database path independently of the prefix.
   */
  readonly namespace: string
}

const initModule = Effect.runSync(Effect.cached(Effect.promise(() => SQLiteAsyncESMFactory())))

const initApi = Effect.runSync(
  Effect.cached(Effect.map(initModule, module => WaSqlite.Factory(module))),
)

const registeredVfs = new Set<string>()

/**
 * The default VFS name prefix. Use a distinct prefix for each application sharing a page.
 */
const DEFAULT_NAMESPACE = 'slotdb'

const classifyError = (cause: unknown, message: string, operation: string) =>
  new SqlError.SqlError({ reason: SqlError.classifySqliteError(cause, { message, operation }) })

const rowToObject = (columns: ReadonlyArray<string>, row: ReadonlyArray<unknown>) => {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = row[i]
  }
  return obj
}

const make = (options: WasmClientOptions) =>
  Effect.gen(function* () {
    const compiler = Statement.makeCompilerSqlite()
    const transformRows = undefined

    const sqlite3 = yield* initApi
    const module = yield* initModule

    const vfsName = `${options.namespace}-${options.vfs}`
    if (!registeredVfs.has(vfsName)) {
      registeredVfs.add(vfsName)
      const vfs = yield* Effect.promise(() =>
        options.vfs === 'opfs'
          ? OPFSAnyContextVFS.create(vfsName, module)
          : MemoryAsyncVFS.create(vfsName, module),
      )
      sqlite3.vfs_register(vfs, false)
    }

    // OPFS paths need a slash to separate the directory and filename.
    const filename =
      options.vfs === 'opfs' && !options.filename.startsWith('/')
        ? `/${options.filename}`
        : options.filename

    const db = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => Promise.resolve(sqlite3.open_v2(filename, undefined, vfsName)),
        catch: cause => classifyError(cause, 'Failed to open database', 'openDatabase'),
      }),
      db => Effect.promise(() => Promise.resolve(sqlite3.close(db))),
    )

    // Serialize statement execution because asyncify cannot suspend concurrent statements
    // safely.
    const executionMutex = yield* Semaphore.make(1)

    const run = (
      sql: string,
      params: ReadonlyArray<unknown> = [],
      rowMode: 'object' | 'array' = 'object',
    ) =>
      // Hold the mutex until the WebAssembly promise completes despite fiber
      // interruption. Releasing early would permit concurrent statements.
      executionMutex.withPermits(1)(
        Effect.uninterruptible(
          Effect.tryPromise({
            try: async () => {
              const results: Array<unknown> = []
              for await (const stmt of sqlite3.statements(db, sql)) {
                sqlite3.bind_collection(stmt, params as Array<SQLiteCompatibleType>)
                let columns: Array<string> | undefined
                while ((await sqlite3.step(stmt)) === WaSqlite.SQLITE_ROW) {
                  columns = columns ?? sqlite3.column_names(stmt)
                  const row = sqlite3.row(stmt)
                  results.push(rowMode === 'object' ? rowToObject(columns, row) : row)
                }
              }
              return results
            },
            catch: cause => classifyError(cause, 'Failed to execute statement', 'execute'),
          }),
        ),
      )

    const connection = identity<SqlConnection.Connection>({
      execute(sql, params, transformRows) {
        return transformRows
          ? Effect.map(run(sql, params), rows => transformRows(rows as Array<object>))
          : run(sql, params)
      },
      executeRaw(sql, params) {
        return run(sql, params)
      },
      executeValues(sql, params) {
        return run(sql, params, 'array') as Effect.Effect<
          ReadonlyArray<ReadonlyArray<unknown>>,
          SqlError.SqlError
        >
      },
      executeValuesUnprepared(sql, params) {
        return this.executeValues(sql, params)
      },
      executeUnprepared(sql, params, transformRows) {
        return this.execute(sql, params, transformRows)
      },
      executeStream(sql, params, transformRows) {
        return Stream.unwrap(
          Effect.map(run(sql, params), rows =>
            Stream.fromIterable(transformRows ? transformRows(rows as Array<object>) : rows),
          ),
        )
      },
    })

    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask(restore => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () =>
          Scope.addFinalizer(scope, semaphore.release(1)),
        ),
        connection,
      )
    })

    return yield* SqlClient.make({
      acquirer,
      compiler,
      transactionAcquirer,
      spanAttributes: [['db.system.name', 'sqlite']],
      transformRows,
    })
  })

const layerFor = (options: WasmClientOptions) =>
  Layer.effectContext(
    Effect.map(make(options), client => Context.make(SqlClient.SqlClient, client)),
  ).pipe(Layer.provide(Reactivity.layer))

/** A SQLite client layer that persists to OPFS. */
export const SqliteClientWasmOpfs = (filename: string, namespace = DEFAULT_NAMESPACE) =>
  layerFor({ vfs: 'opfs', filename, namespace })

/** A SQLite client layer using WebAssembly memory for storage. */
export const SqliteClientWasmMemory = (namespace = DEFAULT_NAMESPACE) =>
  layerFor({ vfs: 'memory', filename: ':memory:', namespace })
