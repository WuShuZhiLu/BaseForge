/**
 * node:sqlite 能力补齐（不是驱动抽象层）
 *
 * 全面替换 better-sqlite3 后，node:sqlite 缺三个原语，这里以原型挂载的方式补上，
 * 让既有 222 处 `db.transaction(...)`、24 处 `db.pragma(...)`、6 处 `db.backup(...)`
 * 调用点保持原样——不引入双驱动、不做运行时探测。
 *
 * 补齐项：
 *   1. transaction(fn) → 返回可直接调用的函数，支持嵌套（内层用 SAVEPOINT），
 *      并提供 better-sqlite3 的 .deferred() / .immediate() / .exclusive() 变体。
 *   2. pragma(sql, { simple }) → 赋值型 PRAGMA 走 prepare().all()，simple 时取首行首列。
 *   3. backup(path) → 包装 node:sqlite 的 backup() 异步函数。
 *
 * 该模块只做副作用挂载，必须在使用数据库之前被 import 一次（db/schema.ts 已引入）。
 */
import { DatabaseSync, StatementSync, backup as sqliteBackup } from "node:sqlite"

type TxMode = "deferred" | "immediate" | "exclusive"

const txDepth = new WeakMap<DatabaseSync, number>()

function depthOf(db: DatabaseSync): number {
  return txDepth.get(db) ?? 0
}

function beginScope(db: DatabaseSync, mode: TxMode): void {
  const depth = depthOf(db)
  if (depth === 0) {
    db.exec(mode === "deferred" ? "BEGIN" : `BEGIN ${mode.toUpperCase()}`)
  } else {
    db.exec(`SAVEPOINT sp_${depth}`)
  }
  txDepth.set(db, depth + 1)
}

function commitScope(db: DatabaseSync): void {
  const depth = depthOf(db) - 1
  if (depth <= 0) {
    db.exec("COMMIT")
    txDepth.set(db, 0)
    return
  }
  db.exec(`RELEASE sp_${depth}`)
  txDepth.set(db, depth)
}

function rollbackScope(db: DatabaseSync): void {
  const depth = depthOf(db) - 1
  if (depth <= 0) {
    db.exec("ROLLBACK")
    txDepth.set(db, 0)
    return
  }
  db.exec(`ROLLBACK TO sp_${depth}`)
  db.exec(`RELEASE sp_${depth}`)
  txDepth.set(db, depth)
}

function makeRunner<T extends (...args: never[]) => unknown>(db: DatabaseSync, fn: T, mode: TxMode) {
  const run = ((...args: Parameters<T>): ReturnType<T> => {
    beginScope(db, mode)
    try {
      const result = fn(...args) as ReturnType<T>
      commitScope(db)
      return result
    } catch (error) {
      try { rollbackScope(db) } catch { /* 事务已失效时忽略回滚错误 */ }
      throw error
    }
  }) as T & { deferred: () => ReturnType<T>; immediate: () => ReturnType<T>; exclusive: () => ReturnType<T> }

  run.deferred = makeVariant(db, fn, "deferred")
  run.immediate = makeVariant(db, fn, "immediate")
  run.exclusive = makeVariant(db, fn, "exclusive")
  return run
}

function makeVariant<T extends (...args: never[]) => unknown>(db: DatabaseSync, fn: T, mode: TxMode) {
  return (): ReturnType<T> => {
    beginScope(db, mode)
    try {
      const result = fn() as ReturnType<T>
      commitScope(db)
      return result
    } catch (error) {
      try { rollbackScope(db) } catch { /* ignore */ }
      throw error
    }
  }
}

type AugmentedDatabase = DatabaseSync & {
  transaction<T extends (...args: never[]) => unknown>(fn: T): ReturnType<typeof makeRunner<T>>
  pragma(sql: string, options?: { simple?: boolean }): unknown
  backup(path: string): Promise<void>
}

const proto = DatabaseSync.prototype as unknown as AugmentedDatabase

if (typeof proto.transaction !== "function") {
  proto.transaction = function transaction(fn) {
    return makeRunner(this as DatabaseSync, fn, "deferred") as never
  }
}

if (typeof proto.pragma !== "function") {
  proto.pragma = function pragma(this: DatabaseSync, sql: string, options?: { simple?: boolean }) {
    const rows = this.prepare(`PRAGMA ${sql}`).all() as Array<Record<string, unknown>>
    if (options?.simple) {
      const first = rows[0]
      return first ? Object.values(first)[0] : undefined
    }
    return rows
  }
}

if (typeof proto.backup !== "function") {
  proto.backup = async function backup(this: DatabaseSync, targetPath: string) {
    await sqliteBackup(this, targetPath)
  }
}

// better-sqlite3 的 inTransaction 在 node:sqlite 里叫 isTransaction，补个别名
if (!("inTransaction" in proto)) {
  Object.defineProperty(proto, "inTransaction", {
    configurable: true,
    get(this: DatabaseSync) {
      return this.isTransaction
    },
  })
}

// run() 的 changes / lastInsertRowid 在 node:sqlite 里是 number | bigint（大整数时为 bigint），
// 而全库把它当 number 用。这里统一收敛为 number，避免 JSON 序列化与算术出错。
//
// 同时做参数归一化：node:sqlite 拒绝 boolean 与 undefined 绑定（better-sqlite3 会自动
// 转成 0/1 与 NULL）。全库有大量 `run(isPinned)`、`run(payload.flag ?? undefined)` 的写法，
// 逐个加断言不现实，统一在绑定前转换。
type RawParams = unknown[]

function normalizeParamValue(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0
  if (value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return value
}

function normalizeParams(args: RawParams): RawParams {
  if (args.length === 0) return args
  const first = args[0]
  // 命名参数对象：逐值归一化
  if (first !== null && typeof first === "object" && !Array.isArray(first) && !(first instanceof Uint8Array)) {
    const mapped: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(first as Record<string, unknown>)) {
      mapped[key] = normalizeParamValue(value)
    }
    return [mapped, ...args.slice(1).map(normalizeParamValue)]
  }
  return args.map(normalizeParamValue)
}

const stmtProto = StatementSync.prototype as unknown as {
  run: (...args: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint }
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown
}

const originalRun = stmtProto.run
stmtProto.run = function run(this: StatementSync, ...args: unknown[]) {
  const result = originalRun.apply(this, normalizeParams(args) as never)
  if (result && typeof result === "object") {
    return {
      ...result,
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    }
  }
  return result
} as typeof stmtProto.run

/**
 * node:sqlite 返回的行是 null-prototype 对象（`[Object: null prototype] {...}`），
 * 与 better-sqlite3 的普通对象在 deepStrictEqual / instanceof Object 下不等价。
 * 统一转成普通对象，保持既有断言与 JSON 序列化行为一致。
 */
function toPlainRow<T>(row: T): T {
  if (row === null || typeof row !== "object") return row
  if (Array.isArray(row) || row instanceof Uint8Array) return row
  return { ...(row as Record<string, unknown>) } as T
}

const originalGet = stmtProto.get
stmtProto.get = function get(this: StatementSync, ...args: unknown[]) {
  return toPlainRow(originalGet.apply(this, normalizeParams(args) as never) as unknown)
} as typeof stmtProto.get

const originalAll = stmtProto.all
stmtProto.all = function all(this: StatementSync, ...args: unknown[]) {
  const rows = originalAll.apply(this, normalizeParams(args) as never) as unknown[]
  return rows.map((row) => toPlainRow(row))
} as typeof stmtProto.all

declare module "node:sqlite" {
  interface DatabaseSync {
    /** 事务：支持嵌套（内层自动 SAVEPOINT），并保留 .deferred/.immediate/.exclusive 变体 */
    transaction<T extends (...args: never[]) => unknown>(
      fn: T,
    ): T & { deferred(): ReturnType<T>; immediate(): ReturnType<T>; exclusive(): ReturnType<T> }
    /** PRAGMA：simple 为真时返回首行首列（better-sqlite3 语义） */
    pragma(sql: string, options?: { simple?: boolean }): unknown
    /** 在线备份到目标路径（异步） */
    backup(path: string): Promise<void>
    /** better-sqlite3 的 inTransaction 别名 */
    readonly inTransaction: boolean
  }

  /**
   * 宽松重载：业务代码里大量存在 `...params: unknown[]` 展开与 Record<string, unknown> 取值，
   * 原签名要求 SQLInputValue，逐个加断言噪音太大。这里补一条 unknown 重载作为兜底
   * （TS 按声明顺序匹配，参数能对上原签名时仍走严格签名）。
   * run 的返回值统一收敛为 number（运行时 sqlite-ext 已把 bigint 转成 number）。
   */
  interface StatementSync {
    all(...anonymousParameters: unknown[]): any[]
    get(...anonymousParameters: unknown[]): any
    run(...anonymousParameters: unknown[]): { changes: number; lastInsertRowid: number }
    iterate(...anonymousParameters: unknown[]): IterableIterator<any>
  }
}
