import { B2NativeClient, type B2File } from "../drivers/s3/b2-native"
import type { S3Addition } from "../drivers/s3/types"

type B2RenameState = "migrating" | "verifying" | "paused"
export type B2RenameJob = {
  id: string
  storage_id: number
  source: string
  target: string
  source_virtual: string
  target_virtual: string
  fingerprint: string
  state: B2RenameState
  cursor: string | null
  scanned: number
  processed: number
  error: string | null
  lease_until: number
}
type B2RenameItem = {
  job_id: string
  source_key: string
  source_id: string
  target_key: string
  size: number
  sha1: string | null
  target_id: string | null
  large_id: string | null
  part_sha1: string | null
}

const schema = [
  `CREATE TABLE IF NOT EXISTS openlist_b2_rename_jobs (
    id TEXT PRIMARY KEY, storage_id INTEGER NOT NULL UNIQUE,
    source TEXT NOT NULL, target TEXT NOT NULL,
    source_virtual TEXT NOT NULL, target_virtual TEXT NOT NULL,
    fingerprint TEXT NOT NULL, state TEXT NOT NULL,
    cursor TEXT, scanned INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0, error TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS openlist_b2_rename_items (
    job_id TEXT NOT NULL, source_key TEXT NOT NULL,
    source_id TEXT NOT NULL, target_key TEXT NOT NULL,
    size INTEGER NOT NULL, sha1 TEXT,
    target_id TEXT, large_id TEXT, part_sha1 TEXT,
    PRIMARY KEY(job_id, source_key))`,
  `CREATE INDEX IF NOT EXISTS openlist_b2_rename_items_pending
    ON openlist_b2_rename_items(job_id, target_id, source_key)`,
]
const initialized = new WeakMap<object, Promise<void>>()

function database(env: any): any {
  const db = env?.DB
  if (typeof db?.prepare !== "function" || typeof db?.batch !== "function")
    throw new Error("B2 background rename requires a D1 DB binding")
  return db
}

async function ready(db: any): Promise<void> {
  let pending = initialized.get(db)
  if (!pending) {
    const created: Promise<void> = (async () => {
      for (const sql of schema) await db.prepare(sql).run()
    })()
    initialized.set(db, created)
    pending = created
  }
  try {
    await pending
  } catch (error) {
    initialized.delete(db)
    throw error
  }
}

function additionFor(storage: any): S3Addition {
  return typeof storage.addition === "string"
    ? JSON.parse(storage.addition || "{}")
    : storage.addition || {}
}

export function isB2Storage(storage: any): boolean {
  if (!storage || storage.disabled) return false
  const driver = String(storage.driver || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
  if (driver !== "b2" && driver !== "s3") return false
  try {
    const endpoint = new URL(
      additionFor(storage).endpoint.includes("://")
        ? additionFor(storage).endpoint
        : `https://${additionFor(storage).endpoint}`,
    )
    return (
      endpoint.protocol === "https:" &&
      /^s3\.[a-z0-9-]+\.backblazeb2\.com$/i.test(endpoint.hostname)
    )
  } catch {
    return false
  }
}

async function storageFingerprint(storage: any): Promise<string> {
  const value = JSON.stringify([
    storage.driver,
    storage.mount_path,
    storage.addition,
  ])
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")
}

const clean = (path: string) => "/" + path.split("/").filter(Boolean).join("/")
const within = (path: string, root: string) =>
  path === root || path.startsWith(root === "/" ? "/" : root + "/")

export async function getB2RenameJob(
  env: any,
  storageId: number,
): Promise<B2RenameJob | null> {
  if (!env?.DB) return null
  const db = database(env)
  await ready(db)
  return (await db
    .prepare("SELECT * FROM openlist_b2_rename_jobs WHERE storage_id = ?")
    .bind(storageId)
    .first()) as B2RenameJob | null
}

export type B2RenameReadContext = {
  env?: any
  b2RenameJobs?: Map<number, Promise<B2RenameJob | null>>
}

// Only read routes opt into this snapshot; mutation guards query D1 directly.
export async function readB2RenameJob(
  storage: any,
  context?: B2RenameReadContext,
): Promise<B2RenameJob | null> {
  if (!isB2Storage(storage)) return null
  const cache = context?.b2RenameJobs
  if (!cache) return getB2RenameJob(context?.env, storage.id)
  const existing = cache.get(storage.id)
  if (existing) return existing
  const pending = getB2RenameJob(context?.env, storage.id)
  cache.set(storage.id, pending)
  try {
    return await pending
  } catch (error) {
    cache.delete(storage.id)
    throw error
  }
}

export async function isB2MigrationLocked(
  env: any,
  storage: any,
  virtualPath: string,
  readContext?: B2RenameReadContext,
): Promise<boolean> {
  const job = await readB2RenameJob(storage, readContext ?? { env })
  const path = clean(virtualPath)
  return !!job && within(path, job.target_virtual)
}

export function b2ReadPaths(
  job: B2RenameJob | null,
  virtualPath: string,
  physicalPath: string,
): string[] {
  if (!job) return [physicalPath]
  const path = clean(virtualPath)
  if (within(path, job.source_virtual))
    throw new Error("Directory was renamed; use its new path")
  if (!within(path, job.target_virtual)) return [physicalPath]
  const suffix = path.slice(job.target_virtual.length)
  return [physicalPath, "/" + job.source + suffix]
}

export function b2OverlayNames(
  job: B2RenameJob | null,
  virtualPath: string,
  items: any[],
): any[] {
  if (
    !job ||
    clean(virtualPath) !==
      clean(
        job.source_virtual.slice(0, job.source_virtual.lastIndexOf("/")) || "/",
      )
  )
    return items
  const oldName = job.source_virtual.split("/").pop()!
  const newName = job.target_virtual.split("/").pop()!
  const oldItem = items.find((item) => item.name === oldName)
  const rest = items.filter(
    (item) => item.name !== oldName && item.name !== newName,
  )
  rest.push({
    ...(oldItem || {
      size: 0,
      modified: new Date().toISOString(),
      sign: "",
      type: 1,
    }),
    name: newName,
    is_dir: true,
    migration: {
      state: job.state,
      processed: job.processed,
      discovered: job.scanned,
      error: job.error,
      source_path: job.source_virtual,
    },
  })
  return rest
}

export function assertB2RenameWritable(
  job: B2RenameJob | null,
  virtualPath: string,
  includeAncestors = false,
): void {
  if (!job) return
  const path = clean(virtualPath)
  if (
    [job.source_virtual, job.target_virtual].some(
      (root) => within(path, root) || (includeAncestors && within(root, path)),
    )
  )
    throw new Error(
      "B2 directory name is syncing; uploads, deletion, move and rename are temporarily disabled",
    )
}

export async function startB2Rename(
  env: any,
  storage: any,
  sourceVirtual: string,
  sourcePhysical: string,
  newName: string,
): Promise<B2RenameJob> {
  if (!isB2Storage(storage)) throw new Error("Storage is not Backblaze B2")
  const db = database(env)
  await ready(db)
  const source = clean(sourcePhysical).slice(1)
  const sourcePrefix = source + "/"
  const parent = source.slice(0, source.lastIndexOf("/") + 1)
  const target = parent + newName
  const targetVirtual = clean(
    sourceVirtual.slice(0, sourceVirtual.lastIndexOf("/")) + "/" + newName,
  )
  if (
    !source ||
    newName === "." ||
    newName === ".." ||
    newName.includes("/") ||
    source === target
  )
    throw new Error("Invalid B2 directory rename")
  const client = new B2NativeClient(additionFor(storage))
  await client.ensureRenameCapabilities()
  if (!(await client.list(sourcePrefix, undefined, 1)).files.length)
    throw new Error("Source directory does not exist")
  if (
    (await client.exact(target)) ||
    (await client.list(target + "/", undefined, 1)).files.length
  )
    throw new Error("Target directory already exists")
  const job: B2RenameJob = {
    id: crypto.randomUUID(),
    storage_id: storage.id,
    source,
    target,
    source_virtual: clean(sourceVirtual),
    target_virtual: targetVirtual,
    fingerprint: await storageFingerprint(storage),
    state: "migrating",
    cursor: null,
    scanned: 0,
    processed: 0,
    error: null,
    lease_until: 0,
  }
  await db
    .prepare(
      `INSERT INTO openlist_b2_rename_jobs
    (id, storage_id, source, target, source_virtual, target_virtual, fingerprint, state,
     cursor, scanned, processed, error, lease_until, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, NULL, 0, ?)`,
    )
    .bind(
      job.id,
      job.storage_id,
      job.source,
      job.target,
      job.source_virtual,
      job.target_virtual,
      job.fingerprint,
      job.state,
      Date.now(),
    )
    .run()
  return job
}

const PART_SIZE = 1024 * 1024 * 1024
const COPY_FILE_LIMIT = 5_000_000_000

async function processItem(
  db: any,
  client: B2NativeClient,
  job: B2RenameJob,
  item: B2RenameItem,
): Promise<boolean> {
  if (!item.target_id) {
    const source = await client.fileInfo(item.source_id)
    if (
      source.fileName !== item.source_key ||
      source.contentLength !== item.size ||
      source.action !== "upload"
    )
      throw new Error(`B2 source version changed: ${item.source_key}`)
    if (source.serverSideEncryption?.mode === "SSE-C")
      throw new Error(`SSE-C file requires a customer key: ${item.source_key}`)
    if (!item.large_id && (await client.exact(item.target_key)))
      throw new Error(`B2 target already exists: ${item.target_key}`)
    if (item.size <= COPY_FILE_LIMIT) {
      const copied = await client.copy(item.source_id, item.target_key)
      if (!copied.fileId) throw new Error("B2 copy returned no fileId")
      item.target_id = copied.fileId
      await db
        .prepare(
          "UPDATE openlist_b2_rename_items SET target_id = ? WHERE job_id = ? AND source_key = ?",
        )
        .bind(item.target_id, job.id, item.source_key)
        .run()
    } else {
      if (!item.large_id) {
        const large = await client.startLarge(source, item.target_key)
        if (!large.fileId) throw new Error("B2 large copy returned no fileId")
        item.large_id = large.fileId
        item.part_sha1 = "[]"
        await db
          .prepare(
            "UPDATE openlist_b2_rename_items SET large_id = ?, part_sha1 = ? WHERE job_id = ? AND source_key = ?",
          )
          .bind(item.large_id, item.part_sha1, job.id, item.source_key)
          .run()
      }
      const hashes = JSON.parse(item.part_sha1 || "[]") as string[]
      const totalParts = Math.ceil(item.size / PART_SIZE)
      if (totalParts > 10000)
        throw new Error("B2 file exceeds the copy-part limit")
      if (hashes.length < totalParts) {
        const partNumber = hashes.length + 1
        const first = hashes.length * PART_SIZE
        const part = await client.copyPart(
          item.source_id,
          item.large_id!,
          partNumber,
          first,
          Math.min(first + PART_SIZE, item.size) - 1,
        )
        if (!/^[a-f0-9]{40}$/i.test(part.contentSha1))
          throw new Error("B2 part copy returned an invalid SHA1")
        hashes.push(part.contentSha1)
        item.part_sha1 = JSON.stringify(hashes)
        await db
          .prepare(
            "UPDATE openlist_b2_rename_items SET part_sha1 = ? WHERE job_id = ? AND source_key = ?",
          )
          .bind(item.part_sha1, job.id, item.source_key)
          .run()
        return false
      }
      try {
        await client.finishLarge(item.large_id!, hashes)
      } catch (error) {
        // B2 does not return unfinished large files from get_file_info. Only
        // use that endpoint after a lost finish response to confirm completion.
        const finished = await client.fileInfo(item.large_id!).catch(() => null)
        if (finished?.action !== "upload" || finished.contentLength !== item.size)
          throw error
      }
      item.target_id = item.large_id
      await db
        .prepare(
          "UPDATE openlist_b2_rename_items SET target_id = ? WHERE job_id = ? AND source_key = ?",
        )
        .bind(item.target_id, job.id, item.source_key)
        .run()
    }
  }
  const target = await client.fileInfo(item.target_id!)
  if (
    target.fileName !== item.target_key ||
    target.contentLength !== item.size ||
    target.action !== "upload" ||
    (item.sha1 && item.sha1 !== "none" && target.contentSha1 !== item.sha1)
  )
    throw new Error(`B2 copy verification failed: ${item.source_key}`)
  if ((await client.exact(item.target_key))?.fileId !== item.target_id)
    throw new Error(`B2 target was replaced: ${item.target_key}`)
  const current = await client.exact(item.source_key)
  if (current && current.fileId !== item.source_id)
    throw new Error(`B2 source was replaced: ${item.source_key}`)
  // Hide first so deleting this version cannot expose an older version at the
  // old name. A lost response is safe to retry: exact() then returns null.
  if (current) await client.hide(item.source_key)
  await client.deleteVersion(item.source_key, item.source_id)
  await db.batch([
    db
      .prepare(
        "DELETE FROM openlist_b2_rename_items WHERE job_id = ? AND source_key = ?",
      )
      .bind(job.id, item.source_key),
    db
      .prepare(
        "UPDATE openlist_b2_rename_jobs SET processed = processed + 1, updated_at = ? WHERE id = ?",
      )
      .bind(Date.now(), job.id),
  ])
  return true
}

/** One bounded Worker invocation. Cron or a client may safely call this again. */
export async function advanceB2Rename(
  env: any,
  storage: any,
  id: string,
): Promise<B2RenameJob | null> {
  const db = database(env)
  await ready(db)
  const now = Date.now()
  const claim = await db
    .prepare(
      `UPDATE openlist_b2_rename_jobs SET lease_until = ?
    WHERE id = ? AND storage_id = ? AND lease_until < ? AND state IN ('migrating', 'verifying')`,
    )
    .bind(now + 300000, id, storage.id, now)
    .run()
  if (!claim.meta?.changes) return getB2RenameJob(env, storage.id)
  try {
    let job = await getB2RenameJob(env, storage.id)
    if (!job || job.id !== id) return null
    if ((await storageFingerprint(storage)) !== job.fingerprint)
      throw new Error("B2 storage configuration changed; migration paused")
    const client = new B2NativeClient(additionFor(storage))
    const sourcePrefix = job.source + "/"
    let items = (
      await db
        .prepare(
          `SELECT * FROM openlist_b2_rename_items
      WHERE job_id = ? ORDER BY source_key LIMIT 4`,
        )
        .bind(id)
        .all()
    ).results as B2RenameItem[]
    if (!items.length && job.state === "migrating") {
      const page = await client.list(sourcePrefix, job.cursor || undefined, 500)
      if (page.files.length) {
        for (let offset = 0; offset < page.files.length; offset += 50) {
          await db.batch(
            page.files.slice(offset, offset + 50).map((file) =>
              db
                .prepare(
                  `INSERT OR IGNORE INTO openlist_b2_rename_items
              (job_id, source_key, source_id, target_key, size, sha1)
              VALUES (?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                  id,
                  file.fileName,
                  file.fileId,
                  job!.target + file.fileName.slice(job!.source.length),
                  file.contentLength,
                  file.contentSha1 || null,
                ),
            ),
          )
        }
      }
      await db
        .prepare(
          `UPDATE openlist_b2_rename_jobs SET cursor = ?, scanned = scanned + ?,
        state = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(
          page.nextFileName || null,
          page.files.length,
          page.nextFileName ? "migrating" : "verifying",
          Date.now(),
          id,
        )
        .run()
      items = (
        await db
          .prepare(
            `SELECT * FROM openlist_b2_rename_items
        WHERE job_id = ? ORDER BY source_key LIMIT 4`,
          )
          .bind(id)
          .all()
      ).results as B2RenameItem[]
    }
    if (items.length) {
      const outcomes = await Promise.allSettled(
        items.map((item) => processItem(db, client, job!, item)),
      )
      const failure = outcomes.find(
        (outcome) => outcome.status === "rejected",
      ) as PromiseRejectedResult | undefined
      if (failure) throw failure.reason
    } else if (job.state === "verifying") {
      if ((await client.list(sourcePrefix, undefined, 1)).files.length)
        throw new Error("B2 source prefix is not empty after migration")
      await db.batch([
        db
          .prepare("DELETE FROM openlist_b2_rename_items WHERE job_id = ?")
          .bind(id),
        db.prepare("DELETE FROM openlist_b2_rename_jobs WHERE id = ?").bind(id),
      ])
      return null
    }
    job = await getB2RenameJob(env, storage.id)
    return job
  } catch (error) {
    await db
      .prepare(
        `UPDATE openlist_b2_rename_jobs SET state = 'paused', error = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(String(error), Date.now(), id)
      .run()
    return getB2RenameJob(env, storage.id)
  } finally {
    await db
      .prepare(
        "UPDATE openlist_b2_rename_jobs SET lease_until = 0 WHERE id = ?",
      )
      .bind(id)
      .run()
  }
}

export async function resumeB2Rename(
  env: any,
  storageId: number,
  id: string,
): Promise<void> {
  const db = database(env)
  await ready(db)
  await db
    .prepare(
      `UPDATE openlist_b2_rename_jobs SET state = 'migrating', error = NULL,
    lease_until = 0 WHERE id = ? AND storage_id = ? AND state = 'paused'`,
    )
    .bind(id, storageId)
    .run()
}

export async function pendingB2Renames(env: any): Promise<B2RenameJob[]> {
  const db = database(env)
  await ready(db)
  return (
    await db
      .prepare(
        `SELECT * FROM openlist_b2_rename_jobs
    WHERE state IN ('migrating', 'verifying') ORDER BY updated_at LIMIT 20`,
      )
      .all()
  ).results as B2RenameJob[]
}
