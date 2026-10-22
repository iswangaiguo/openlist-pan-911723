import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { DatabaseSync } from "node:sqlite"
import {
  advanceB2Rename,
  assertB2RenameWritable,
  b2OverlayNames,
  b2ReadPaths,
  getB2RenameJob,
  startB2Transfer,
} from "./b2_rename"

function d1(sqlite = new DatabaseSync(":memory:")) {
  const prepare = (sql: string) => {
    const statement = sqlite.prepare(sql)
    const bound = (...values: any[]) => ({
      run: async () => ({
        meta: { changes: Number(statement.run(...values).changes) },
      }),
      first: async () => statement.get(...values) || null,
      all: async () => ({ results: statement.all(...values) }),
    })
    return { ...bound(), bind: bound }
  }
  return {
    sqlite,
    prepare,
    batch: async (statements: { run: () => Promise<any> }[]) => {
      const result = []
      for (const statement of statements) result.push(await statement.run())
      return result
    },
  }
}

/** Minimal B2 Native API keeping every file version, newest first. */
function mockB2(t: TestContext, files: [string, number][]) {
  const versions = new Map<string, any[]>()
  for (const [name, size] of files)
    versions.set(name, [
      {
        fileId: `source-${name}`,
        fileName: name,
        contentLength: size,
        contentSha1: "a".repeat(40),
        action: "upload",
      },
    ])
  const operations: string[] = []
  const latest = (name: string) => versions.get(name)?.[0]
  t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    const operation = String(input).split("/").pop()!
    if (operation === "b2_authorize_account")
      return Response.json({
        accountId: "account",
        authorizationToken: "token",
        apiInfo: {
          storageApi: {
            apiUrl: "https://api.test",
            allowed: { buckets: [{ id: "bucket-id", name: "bucket" }] },
          },
        },
      })
    const body = JSON.parse(init?.body || "{}")
    operations.push(operation)
    if (operation === "b2_list_file_names") {
      const names = [...versions.keys()]
        .sort()
        .filter(
          (name) =>
            name.startsWith(body.prefix) &&
            (!body.startFileName || name >= body.startFileName) &&
            latest(name)?.action === "upload",
        )
      return Response.json({
        files: names.slice(0, body.maxFileCount).map(latest),
        nextFileName: names[body.maxFileCount] || null,
      })
    }
    if (operation === "b2_get_file_info") {
      const file = [...versions.values()]
        .flat()
        .find((entry) => entry.fileId === body.fileId)
      return file
        ? Response.json(file)
        : Response.json({ code: "not_found" }, { status: 404 })
    }
    if (operation === "b2_copy_file") {
      const source = [...versions.values()]
        .flat()
        .find((entry) => entry.fileId === body.sourceFileId)
      const copied = {
        ...source,
        fileId: `copy-${body.fileName}`,
        fileName: body.fileName,
      }
      versions.set(body.fileName, [copied])
      return Response.json(copied)
    }
    if (operation === "b2_hide_file") {
      const marker = {
        fileId: `hide-${body.fileName}`,
        fileName: body.fileName,
        contentLength: 0,
        action: "hide",
      }
      versions.set(body.fileName, [marker, ...(versions.get(body.fileName) || [])])
      return Response.json(marker)
    }
    if (operation === "b2_delete_file_version") {
      versions.set(
        body.fileName,
        (versions.get(body.fileName) || []).filter(
          (entry) => entry.fileId !== body.fileId,
        ),
      )
      return Response.json({})
    }
    throw new Error(`Unexpected B2 call: ${operation}`)
  })
  return { versions, operations, latest }
}

const storage = {
  id: 23,
  driver: "B2",
  mount_path: "/",
  addition: JSON.stringify({
    endpoint: "s3.us-west-004.backblazeb2.com",
    bucket: "bucket",
    access_key_id: "key",
    secret_access_key: "secret",
  }),
}
const FILES: [string, number][] = [
  ["old/a.mp4", 4],
  ["old/sub/b.mp4", 5],
]

async function runToEnd(env: any, id: string) {
  for (let i = 0; i < 20; i++)
    if (!(await advanceB2Rename(env, storage, id))) return
  throw new Error("job did not finish")
}

test("moving a B2 folder to another directory runs as a background job", async (t) => {
  const b2 = mockB2(t, FILES)
  const env = { DB: d1() }
  const job = await startB2Transfer(
    env, storage, "/old", "/old", "/archive/old", "/archive/old", "move",
  )
  assert.equal(job.mode, "move")
  // The source disappears at once; the target shows up with progress.
  assert.throws(() => b2ReadPaths(job, "/old/a.mp4", "/old/a.mp4"), /moved/)
  assert.deepEqual(
    b2OverlayNames(job, "/", [{ name: "old" }, { name: "archive" }]).map((i) => i.name),
    ["archive"],
  )
  const listed = b2OverlayNames(job, "/archive", [])
  assert.equal(listed[0].name, "old")
  assert.equal(listed[0].migration.mode, "move")
  assert.deepEqual(b2ReadPaths(job, "/archive/old/a.mp4", "/archive/old/a.mp4"), [
    "/archive/old/a.mp4",
    "/old/a.mp4",
  ])
  assert.throws(() => assertB2RenameWritable(job, "/archive/old/x"), /syncing/)

  await runToEnd(env, job.id)
  assert.equal(await getB2RenameJob(env, storage.id), null)
  assert.equal(b2.latest("archive/old/sub/b.mp4")?.fileId, "copy-archive/old/sub/b.mp4")
  assert.equal(b2.latest("old/a.mp4")?.action, "hide")
})

test("copying a B2 folder keeps the source readable and untouched", async (t) => {
  const b2 = mockB2(t, FILES)
  const env = { DB: d1() }
  const job = await startB2Transfer(
    env, storage, "/old", "/old", "/backup/old", "/backup/old", "copy",
  )
  assert.deepEqual(b2ReadPaths(job, "/old/a.mp4", "/old/a.mp4"), ["/old/a.mp4"])
  assert.deepEqual(
    b2OverlayNames(job, "/", [{ name: "old" }]).map((i) => i.name),
    ["old"],
  )
  assert.equal(b2OverlayNames(job, "/backup", [])[0].migration.mode, "copy")

  await runToEnd(env, job.id)
  assert.equal(await getB2RenameJob(env, storage.id), null)
  assert.equal(b2.latest("backup/old/a.mp4")?.fileId, "copy-backup/old/a.mp4")
  assert.equal(b2.latest("old/a.mp4")?.action, "upload")
  assert.equal(b2.latest("old/sub/b.mp4")?.action, "upload")
  assert.ok(!b2.operations.includes("b2_hide_file"))
  assert.ok(!b2.operations.includes("b2_delete_file_version"))
})

test("a folder can't go into itself, and one job runs per storage", async (t) => {
  mockB2(t, FILES)
  const env = { DB: d1() }
  await assert.rejects(
    startB2Transfer(env, storage, "/old", "/old", "/old/sub/x", "/old/sub/x", "move"),
    /into itself/,
  )
  await startB2Transfer(env, storage, "/old", "/old", "/n1", "/n1", "copy")
  await assert.rejects(
    startB2Transfer(env, storage, "/old", "/old", "/n2", "/n2", "copy"),
    /still running/,
  )
})

test("job tables from before move/copy support gain the mode column", async (t) => {
  mockB2(t, FILES)
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec(`CREATE TABLE openlist_b2_rename_jobs (
    id TEXT PRIMARY KEY, storage_id INTEGER NOT NULL UNIQUE,
    source TEXT NOT NULL, target TEXT NOT NULL,
    source_virtual TEXT NOT NULL, target_virtual TEXT NOT NULL,
    fingerprint TEXT NOT NULL, state TEXT NOT NULL,
    cursor TEXT, scanned INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0, error TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL)`)
  sqlite.exec(`INSERT INTO openlist_b2_rename_jobs
    (id, storage_id, source, target, source_virtual, target_virtual, fingerprint, state, updated_at)
    VALUES ('legacy', 23, 'old', 'new', '/old', '/new', 'f', 'paused', 0)`)
  const job = await getB2RenameJob({ DB: d1(sqlite) }, 23)
  assert.equal(job?.mode, "rename")
})

test("fs move/copy of a B2 folder starts a job; a single file moves at once", async (t) => {
  const { moveItems, copyItems } = await import("../internal/op/storage")
  const { saveDb, __setStoreBackendLoaderForTest, __resetDbCacheForTest } =
    await import("../internal/model/db")
  const b2 = mockB2(t, [...FILES, ["clip.mp4", 3]])
  const b2Fetch = globalThis.fetch
  const s3Calls: string[] = []
  // S3 API calls (used for HEAD/list/copy) go to the bucket endpoint.
  t.mock.method(globalThis, "fetch", async (input: any, init: any = {}) => {
    const url = new URL(String(input))
    if (!url.hostname.startsWith("bucket.s3.")) return b2Fetch(input, init)
    const method = String(init.method || "GET").toUpperCase()
    s3Calls.push(`${method} ${url.pathname}`)
    // Virtual-host style: bucket.s3.<region>.backblazeb2.com/<key>
    const key = decodeURIComponent(url.pathname).slice(1)
    const file = b2.latest(key)
    if (method === "HEAD")
      return file?.action === "upload"
        ? new Response(null, {
            headers: { "content-length": String(file.contentLength), etag: '"e"' },
          })
        : new Response(null, { status: 404 })
    if (method === "PUT") {
      const src = decodeURIComponent(new Headers(init.headers).get("x-amz-copy-source")!)
        .replace(/^bucket\//, "")
      b2.versions.set(key, [{ ...b2.latest(src), fileName: key }])
      return new Response('<CopyObjectResult><ETag>"e"</ETag></CopyObjectResult>')
    }
    if (method === "DELETE") {
      b2.versions.delete(key)
      return new Response(null, { status: 204 })
    }
    const prefix = url.searchParams.get("prefix") || ""
    const has = [...b2.versions.keys()].some((name) => name.startsWith(prefix))
    return new Response(
      `<ListBucketResult><IsTruncated>false</IsTruncated>${has ? "<Contents><Key>x</Key></Contents>" : ""}</ListBucketResult>`,
    )
  })
  let data: any = {
    settings: [],
    users: [],
    storages: [
      { ...storage, mount_path: "/B2", status: "work", modified: "fs-transfer" },
    ],
    metas: [],
    shares: [],
  }
  __resetDbCacheForTest()
  __setStoreBackendLoaderForTest(async () => ({
    name: "test",
    isConfigured: async () => true,
    load: async () => structuredClone(data),
    save: async (next: any) => {
      data = structuredClone(next)
      return true
    },
  }))
  t.after(() => __resetDbCacheForTest())
  await saveDb(data)
  const env = { DB: d1() }

  await moveItems("/B2", "/B2/archive", ["clip.mp4"], { env })
  assert.equal(b2.latest("archive/clip.mp4")?.contentLength, 3)
  assert.equal(await getB2RenameJob(env, storage.id), null)

  await copyItems("/B2", "/B2/backup", ["old"], { env })
  const job = await getB2RenameJob(env, storage.id)
  assert.equal(job?.mode, "copy")
  assert.equal(job?.target, "backup/old")
  assert.equal(job?.target_virtual, "/B2/backup/old")
  assert.ok(!s3Calls.some((call) => call.startsWith("PUT /backup")))
})
