import type { FileItem } from "../driver/base"
import { resolveCacheExpiration } from "../driver/storageopts"

export type DirectoryCacheStatus = "HIT" | "MISS" | "REFRESH" | "BYPASS"
export interface DirectoryCacheContext {
  env?: any
  refreshDirectory?: boolean
  onDirectoryCache?: (status: DirectoryCacheStatus) => void
}

// Private metadata only: never cache a response, permissions or signed URLs.
const MAX_BYTES = 512 * 1024
const MAX_ENTRIES = 256
const initialized = new WeakMap<object, Promise<void>>()
const flights = new WeakMap<object, Map<string, Promise<FileItem[]>>>()
const ddl = [
  `CREATE TABLE IF NOT EXISTS openlist_directory_epoch (
    scope TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS openlist_directory_cache (
    key TEXT PRIMARY KEY, scope TEXT NOT NULL, revision INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS openlist_directory_cache_scope ON openlist_directory_cache(scope)`,
  `CREATE INDEX IF NOT EXISTS openlist_directory_cache_age ON openlist_directory_cache(updated_at)`,
]

function database(context?: DirectoryCacheContext): any | null {
  const env = context?.env
  if (String(env?.DIRECTORY_CACHE_ENABLED) !== "true") return null
  const db = env.DB || env.OPENLIST_DB
  return typeof db?.prepare === "function" && typeof db?.batch === "function"
    ? db
    : null
}

export function supportsDirectoryCache(storage: any): boolean {
  const driver = String(storage?.driver || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
  return ["s3", "b2", "r2", "minio", "cos", "oss", "cloudflarer2"].includes(
    driver,
  )
}

async function ready(db: any): Promise<void> {
  let pending = initialized.get(db)
  if (!pending) {
    pending = db
      .batch(ddl.map((sql) => db.prepare(sql)))
      .then(() => {}) as Promise<void>
    initialized.set(db, pending)
  }
  try {
    await pending
  } catch (error) {
    initialized.delete(db)
    throw error
  }
}

// Storage-wide epochs also cover renamed/deleted subtrees.
// Configuration changes get a different fingerprint below.
function scopeFor(storage: any): string {
  return String(storage.id)
}
async function keyFor(
  storage: any,
  path: string,
  ttl: number,
): Promise<string> {
  const input = JSON.stringify([
    storage.id,
    storage.driver,
    storage.mount_path,
    storage.modified,
    storage.addition,
    path,
    ttl,
  ])
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  )
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")
}

async function bump(db: any, scope: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO openlist_directory_epoch(scope, revision) VALUES (?, 1)
      ON CONFLICT(scope) DO UPDATE SET revision = revision + 1`,
      )
      .bind(scope),
    db
      .prepare("DELETE FROM openlist_directory_cache WHERE scope = ?")
      .bind(scope),
  ])
}

/** Invalidations are awaited, including after partial failure, never waitUntil. */
export async function withDirectoryMutation<T>(
  storages: any[],
  context: DirectoryCacheContext | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const db = database(context)
  const scopes = [
    ...new Set(storages.filter(supportsDirectoryCache).map(scopeFor)),
  ]
  if (!db || !scopes.length) return action()
  // Fail before changing storage if we cannot invalidate shared state.
  await ready(db)
  for (const scope of scopes) await bump(db, scope)
  try {
    return await action()
  } finally {
    for (const scope of scopes) await bump(db, scope)
  }
}

export async function cachedDirectory(
  storage: any,
  physicalPath: string,
  virtualPath: string,
  context: DirectoryCacheContext | undefined,
  load: () => Promise<FileItem[]>,
): Promise<FileItem[]> {
  const db = database(context)
  const configuredMax = Number(context?.env?.DIRECTORY_CACHE_MAX_SECONDS ?? 300)
  const maxSeconds = Number.isFinite(configuredMax)
    ? Math.max(0, configuredMax)
    : 300
  const ttl = Math.min(
    resolveCacheExpiration(storage, virtualPath) * 60,
    maxSeconds,
  )
  if (!db || !supportsDirectoryCache(storage) || ttl <= 0) {
    context?.onDirectoryCache?.("BYPASS")
    return load()
  }
  let key: string, scope: string, revision: number
  try {
    await ready(db)
    key = await keyFor(storage, physicalPath, ttl)
    scope = scopeFor(storage)
    if (context?.refreshDirectory) await bump(db, scope)
    // A single primary D1 read checks the current epoch and the payload together.
    // Do not use a read-replica session here: mutations must invalidate all isolates.
    const row = await db
      .prepare(
        `SELECT COALESCE(e.revision, 0) AS revision,
        c.payload, c.expires_at FROM (SELECT ? AS scope) s
      LEFT JOIN openlist_directory_epoch e ON e.scope = s.scope
      LEFT JOIN openlist_directory_cache c ON c.key = ? AND c.scope = s.scope
        AND c.revision = COALESCE(e.revision, 0)`,
      )
      .bind(scope, key)
      .first()
    revision = Number(row.revision)
    if (row.payload && row.expires_at > Date.now()) {
      const items = JSON.parse(row.payload)
      if (!Array.isArray(items)) throw new Error("Invalid directory cache")
      context?.onDirectoryCache?.("HIT")
      return items
    }
  } catch {
    context?.onDirectoryCache?.("BYPASS")
    return load() // Cache outage must not prevent reading files.
  }
  context?.onDirectoryCache?.(context?.refreshDirectory ? "REFRESH" : "MISS")
  let pending = flights.get(db)
  if (!pending) {
    pending = new Map()
    flights.set(db, pending)
  }
  const flightKey = `${key}:${revision}`
  let job = pending.get(flightKey)
  if (!job) {
    job = (async () => {
      const items = await load() // Errors are never cached.
      // Allowlist excludes raw links, auth headers and provider tokens.
      const metadata = items.map(
        ({ name, size, is_dir, modified, created, type }) => ({
          name,
          size,
          is_dir,
          modified,
          created,
          type,
          sign: "",
        }),
      )
      const payload = JSON.stringify(metadata)
      if (new TextEncoder().encode(payload).length <= MAX_BYTES) {
        const now = Date.now()
        try {
          await db.batch([
            // Compare-and-set: a slow pre-mutation list must not resurrect old data.
            db
              .prepare(
                `INSERT INTO openlist_directory_cache(key, scope, revision, expires_at, updated_at, payload)
              SELECT ?, ?, ?, ?, ?, ? WHERE COALESCE(
                (SELECT revision FROM openlist_directory_epoch WHERE scope = ?), 0) = ?
              ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,
                expires_at=excluded.expires_at, updated_at=excluded.updated_at, payload=excluded.payload`,
              )
              .bind(
                key,
                scope,
                revision,
                now + ttl * 1000,
                now,
                payload,
                scope,
                revision,
              ),
            db
              .prepare(
                "DELETE FROM openlist_directory_cache WHERE expires_at <= ?",
              )
              .bind(now),
            db
              .prepare(
                `DELETE FROM openlist_directory_cache WHERE key IN
              (SELECT key FROM openlist_directory_cache ORDER BY updated_at DESC LIMIT -1 OFFSET ?)`,
              )
              .bind(MAX_ENTRIES),
          ])
        } catch {
          /* A failed cache write doesn't fail the directory read. */
        }
      }
      return metadata
    })()
    pending.set(flightKey, job)
  }
  try {
    return structuredClone(await job)
  } finally {
    if (pending.get(flightKey) === job) pending.delete(flightKey)
  }
}
