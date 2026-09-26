/**
 * 服务层 Multipart 上传会话管理器。
 *
 * 目标：让 TS 后端提供与官方前端 `multipart.ts` 完全一致的 API 契约
 * （/fs/multipart/init | chunk | complete | status），内部桥接到驱动层的
 * createUploadSession / uploadPart / completeUploadSession（会话式分片）。
 *
 * 说明：
 * - D1 deployments persist sessions and each part separately, so parallel
 *   acknowledgements survive cold starts without overwriting one another.
 * - Non-D1 runtimes retain the existing in-process session store.
 * - chunk 按 index（0-based）桥接到驱动 uploadPart(partNumber = index + 1)，
 *   与官方前端 multipart.ts 的 chunk index 语义对齐。
 * - received 以区间数组 [number, number][] 表示，供前端断点续传跳过已收分片。
 */

export type MultipartState =
  | "receiving"
  | "completed"
  | "failed_retriable"
  | "failed_permanent"
  | "aborted"

export interface MultipartSession {
  upload_id: string
  /** Owner, actual directory and storage configuration fingerprint. */
  scope: string
  file_md5: string
  state: MultipartState
  attempt: number
  path: string
  size: number
  chunk_size: number
  total_chunks: number
  /** 已收到分片 index 集合（0-based） */
  received: Set<number>
  /** 驱动层 session token（createUploadSession 返回） */
  driver_session: string
  /** 驱动层分片 md5（complete 时传给 completeUploadSession） */
  partMd5s: (string | undefined)[]
  /** 驱动名 + 存储引用，用于 chunk/complete 时重新 resolve 驱动 */
  storage_driver: string
  created_at: number
  error?: string
}

export interface MultipartSnapshot {
  upload_id: string
  state: MultipartState
  attempt: number
  path: string
  size: number
  chunk_size: number
  total_chunks: number
  received: [number, number][]
  received_bytes: number
  frontier: number
  storage_progress: number
  error?: string
}

const sessions = new Map<string, MultipartSession>()

const CHUNK_MIN = 1 * 1024 * 1024 // 1MB
const CHUNK_MAX = 64 * 1024 * 1024 // 64MB
const CHUNK_DEFAULT = 10 * 1024 * 1024 // 10MB

/** 将前端建议的 chunk_size clamp 到 [1MB, 64MB] */
export function clampChunkSize(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return CHUNK_DEFAULT
  return Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, Math.floor(raw)))
}

/** 区间数组 → 有序区间列表（合并相邻） */
function intervalsOf(set: Set<number>): [number, number][] {
  const arr = Array.from(set).sort((a, b) => a - b)
  if (arr.length === 0) return []
  const out: [number, number][] = []
  let start = arr[0]
  let end = arr[0]
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === end + 1) {
      end = arr[i]
    } else {
      out.push([start, end])
      start = end = arr[i]
    }
  }
  out.push([start, end])
  return out
}

export function snapshot(s: MultipartSession): MultipartSnapshot {
  const intervals = intervalsOf(s.received)
  const receivedBytes = Array.from(s.received).reduce(
    (bytes, index) =>
      bytes + Math.min(s.chunk_size, s.size - index * s.chunk_size),
    0,
  )
  // frontier：连续已收的最大 index + 1（驱动顺序写入进度）
  let frontier = 0
  for (let i = 0; i < s.total_chunks; i++) {
    if (!s.received.has(i)) break
    frontier = i + 1
  }
  const storageProgress =
    s.total_chunks > 0
      ? Math.floor((s.received.size / s.total_chunks) * 100)
      : 0
  return {
    upload_id: s.upload_id,
    state: s.state,
    attempt: s.attempt,
    path: s.path,
    size: s.size,
    chunk_size: s.chunk_size,
    total_chunks: s.total_chunks,
    received: intervals,
    received_bytes: receivedBytes,
    frontier,
    storage_progress: storageProgress,
    error: s.error,
  }
}

const initialized = new WeakMap<object, Promise<void>>()
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000

async function database(env?: any): Promise<any | undefined> {
  const binding = env?.DB || env?.OPENLIST_DB
  if (
    typeof binding?.prepare !== "function" ||
    typeof binding?.batch !== "function"
  )
    return
  // Read-your-writes consistency also applies when D1 read replication is enabled.
  const db =
    typeof binding.withSession === "function"
      ? binding.withSession("first-primary")
      : binding
  let ready = initialized.get(binding)
  if (!ready) {
    ready = db
      .batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS openlist_upload_sessions (
        upload_id TEXT PRIMARY KEY, scope TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
        state TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL,
        complete_lock_until INTEGER NOT NULL DEFAULT 0)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS openlist_upload_parts (
        upload_id TEXT NOT NULL, part_index INTEGER NOT NULL, etag TEXT,
        PRIMARY KEY (upload_id, part_index))`),
        db.prepare(
          `CREATE UNIQUE INDEX IF NOT EXISTS openlist_upload_resume ON openlist_upload_sessions(scope, path, size) WHERE state IN ('receiving', 'failed_retriable')`,
        ),
      ])
      .then(() => {})
    initialized.set(binding, ready!)
  }
  try {
    await ready
  } catch (error) {
    initialized.delete(binding)
    throw error
  }
  return db
}

/** Bound memory even when Content-Length is missing or inaccurate. */
export function canStreamPartBody(): boolean {
  return typeof (globalThis as any).FixedLengthStream === "function"
}

/** Native Workers piping enforces length without buffering or a JS loop over the body. */
export async function pipePartBody<T>(
  request: Request,
  expected: number,
  upload: (body: ReadableStream<Uint8Array>) => Promise<T>,
): Promise<T> {
  if (!request.body) throw new Error("Missing chunk body")
  const fixed = new (globalThis as any).FixedLengthStream(expected)
  const abort = new AbortController()
  const piping = request.body.pipeTo(fixed.writable, { signal: abort.signal })
  try {
    const [result] = await Promise.all([upload(fixed.readable), piping])
    return result
  } finally {
    // Also stop an unfinished incoming body when the provider rejects the part.
    abort.abort()
  }
}

export async function readPartBody(
  request: Request,
  expected: number,
): Promise<Uint8Array | undefined> {
  if (!request.body) return
  const reader = request.body.getReader()
  const bytes = new Uint8Array(expected)
  let offset = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return offset === expected ? bytes : undefined
      if (offset + value.length > expected) {
        await reader.cancel().catch(() => {})
        return
      }
      bytes.set(value, offset)
      offset += value.length
    }
  } finally {
    reader.releaseLock()
  }
}

export async function uploadScope(
  user: any,
  storage: any,
  actualDir: string,
  md5: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      user.id,
      user.base_path,
      actualDir,
      storage.id,
      storage.driver,
      storage.mount_path,
      storage.addition,
      md5,
    ]),
  )
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")
}

export async function getSession(
  uploadId: string,
  env?: any,
): Promise<MultipartSession | undefined> {
  const db = await database(env)
  if (!db) {
    const s = sessions.get(uploadId)
    return s && Date.now() - s.created_at < SESSION_TTL ? s : undefined
  }
  const row = await db
    .prepare(
      `SELECT payload, state FROM openlist_upload_sessions
    WHERE upload_id = ? AND expires_at > ?`,
    )
    .bind(uploadId, Date.now())
    .first()
  if (!row) return
  const session: MultipartSession = JSON.parse(row.payload)
  session.state = row.state
  session.received = new Set<number>()
  session.partMd5s = new Array(session.total_chunks).fill(undefined)
  const parts = await db
    .prepare(
      `SELECT part_index, etag FROM openlist_upload_parts
    WHERE upload_id = ? ORDER BY part_index`,
    )
    .bind(uploadId)
    .all()
  for (const part of parts.results) {
    session.received.add(part.part_index)
    session.partMd5s[part.part_index] = part.etag ?? undefined
  }
  // Rapid uploads have no part records.
  if (session.state === "completed" && !session.received.size) {
    session.received = new Set(
      Array.from({ length: session.total_chunks }, (_, i) => i),
    )
  }
  return session
}

export async function findReceivingSession(
  path: string,
  size: number,
  scope: string,
  env?: any,
): Promise<MultipartSession | undefined> {
  const db = await database(env)
  if (!db)
    return Array.from(sessions.values()).find(
      (s) =>
        s.path === path &&
        s.size === size &&
        s.scope === scope &&
        Date.now() - s.created_at < SESSION_TTL &&
        (s.state === "receiving" || s.state === "failed_retriable"),
    )
  const row = await db
    .prepare(
      `SELECT upload_id FROM openlist_upload_sessions
    WHERE scope = ? AND path = ? AND size = ? AND state IN ('receiving', 'failed_retriable')
    AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`,
    )
    .bind(scope, path, size, Date.now())
    .first()
  return row ? getSession(row.upload_id, env) : undefined
}

export async function putSession(
  s: MultipartSession,
  env?: any,
): Promise<void> {
  const db = await database(env)
  if (!db) {
    sessions.set(s.upload_id, s)
    return
  }
  const payload = JSON.stringify({
    ...s,
    received: undefined,
    partMd5s: undefined,
  })
  await db
    .prepare(
      `INSERT INTO openlist_upload_sessions(upload_id, scope, path, size, state, payload, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(upload_id) DO UPDATE SET
    state = excluded.state, payload = excluded.payload, expires_at = excluded.expires_at,
    complete_lock_until = 0`,
    )
    .bind(
      s.upload_id,
      s.scope,
      s.path,
      s.size,
      s.state,
      payload,
      Date.now() + SESSION_TTL,
    )
    .run()
}

export async function recordPart(
  s: MultipartSession,
  index: number,
  etag: string | undefined,
  env?: any,
): Promise<MultipartSession> {
  const db = await database(env)
  if (!db) {
    s.received.add(index)
    s.partMd5s[index] = etag
    return s
  }
  // Never write an entire stale received set: other instances may be acknowledging parts concurrently.
  await db.batch([
    db
      .prepare(
        `INSERT INTO openlist_upload_parts(upload_id, part_index, etag)
      VALUES (?, ?, ?) ON CONFLICT(upload_id, part_index) DO UPDATE SET etag = excluded.etag`,
      )
      .bind(s.upload_id, index, etag ?? null),
    db
      .prepare(
        `UPDATE openlist_upload_sessions SET expires_at = ? WHERE upload_id = ?`,
      )
      .bind(Date.now() + SESSION_TTL, s.upload_id),
  ])
  return (await getSession(s.upload_id, env))!
}

export async function claimCompletion(
  s: MultipartSession,
  env?: any,
): Promise<boolean> {
  const db = await database(env)
  if (!db) {
    if (completionLocks.has(s.upload_id)) return false
    completionLocks.add(s.upload_id)
    return true
  }
  const row = await db
    .prepare(
      `UPDATE openlist_upload_sessions SET complete_lock_until = ?
    WHERE upload_id = ? AND state IN ('receiving', 'failed_retriable') AND complete_lock_until < ?
    RETURNING upload_id`,
    )
    .bind(Date.now() + 10 * 60 * 1000, s.upload_id, Date.now())
    .first()
  return !!row
}
const completionLocks = new Set<string>()
export function releaseCompletion(s: MultipartSession): void {
  completionLocks.delete(s.upload_id)
}

/** 生成 upload_id */
export function newUploadId(): string {
  const rnd =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `mp_${rnd}`
}

/** Remove expired local records. Provider-side unfinished uploads use the bucket lifecycle policy. */
export async function pruneSessions(env?: any): Promise<void> {
  const now = Date.now()
  const db = await database(env)
  if (db) {
    await db.batch([
      db
        .prepare(
          `DELETE FROM openlist_upload_parts WHERE upload_id IN
        (SELECT upload_id FROM openlist_upload_sessions WHERE expires_at <= ?)`,
        )
        .bind(now),
      db
        .prepare(`DELETE FROM openlist_upload_sessions WHERE expires_at <= ?`)
        .bind(now),
    ])
  } else {
    for (const [id, s] of sessions) {
      if (now - s.created_at >= SESSION_TTL) {
        sessions.delete(id)
        completionLocks.delete(id)
      }
    }
  }
}
