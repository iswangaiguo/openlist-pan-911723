import assert from "node:assert/strict"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import {
  advanceB2Rename,
  assertB2RenameWritable,
  b2OverlayNames,
  b2ReadPaths,
  getB2RenameJob,
  startB2Rename,
} from "./b2_rename"

function d1() {
  const sqlite = new DatabaseSync(":memory:")
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
    prepare,
    batch: async (statements: { run: () => Promise<any> }[]) => {
      const result = []
      for (const statement of statements) result.push(await statement.run())
      return result
    },
  }
}

test("B2 rename shows a temporary alias, copies by fileId and removes the alias", async (t) => {
  const db = d1()
  const versions = new Map<string, any[]>()
  for (const [name, size] of [
    ["old/a.mp4", 4],
    ["old/b.mp4", 5],
    ["old/sub/c.mp4", 6],
  ] as const) {
    versions.set(name, [
      {
        fileId: `source-${name}`,
        fileName: name,
        contentLength: size,
        contentSha1: "a".repeat(40),
        contentType: "video/mp4",
        fileInfo: {},
        action: "upload",
      },
    ])
  }
  const operations: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: any, init?: any) => {
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
    const latest = (name: string) => versions.get(name)?.[0]
    if (operation === "b2_list_file_names") {
      const files = [...versions.keys()]
        .sort()
        .filter(
          (name) =>
            name.startsWith(body.prefix) &&
            (!body.startFileName || name >= body.startFileName) &&
            latest(name)?.action === "upload",
        )
      const page = files.slice(0, body.maxFileCount)
      return Response.json({
        files: page.map((name) => latest(name)),
        nextFileName: files[body.maxFileCount] || null,
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
      assert.ok(source)
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
      versions.set(body.fileName, [
        marker,
        ...(versions.get(body.fileName) || []),
      ])
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
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const storage = {
    id: 17,
    driver: "B2",
    mount_path: "/",
    addition: JSON.stringify({
      endpoint: "s3.us-west-004.backblazeb2.com",
      bucket: "bucket",
      access_key_id: "key",
      secret_access_key: "secret",
    }),
  }
  const env = { DB: db }
  const job = await startB2Rename(env, storage, "/old", "/old", "new")
  assert.deepEqual(b2ReadPaths(job, "/new/sub/c.mp4", "/new/sub/c.mp4"), [
    "/new/sub/c.mp4",
    "/old/sub/c.mp4",
  ])
  assert.throws(() => b2ReadPaths(job, "/old", "/old"), /renamed/)
  assert.throws(() => assertB2RenameWritable(job, "/new/upload.mp4"), /syncing/)
  assert.doesNotThrow(() => assertB2RenameWritable(job, "/other/upload.mp4"))
  assert.doesNotThrow(() => assertB2RenameWritable(job, "/"))
  assert.throws(() => assertB2RenameWritable(job, "/", true), /syncing/)
  assert.deepEqual(
    b2OverlayNames(job, "/", [{ name: "old", is_dir: true }]).map(
      (item) => item.name,
    ),
    ["new"],
  )
  for (let i = 0; i < 10; i++) {
    if (!(await advanceB2Rename(env, storage, job.id))) break
  }
  assert.equal(await getB2RenameJob(env, storage.id), null)
  assert.equal(versions.get("new/a.mp4")?.[0].fileId, "copy-new/a.mp4")
  assert.equal(versions.get("old/a.mp4")?.[0].action, "hide")
  assert.equal(
    operations.filter((operation) => operation === "b2_copy_file").length,
    3,
  )
  assert.equal(
    operations.filter((operation) => operation === "b2_delete_file_version")
      .length,
    3,
  )
})

test("B2 large file copies in persisted parts and resumes after a fresh step", async (t) => {
  const db = d1()
  const size = 5_000_000_001
  const source = {
    fileId: "source-large",
    fileName: "old/big.mkv",
    contentLength: size,
    contentSha1: "none",
    contentType: "video/x-matroska",
    fileInfo: {},
    action: "upload",
  }
  let sourceVisible = true
  let target: any = null
  let partNumbers: number[] = []
  let finished = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: any, init?: any) => {
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
    if (operation === "b2_list_file_names") {
      const files = []
      if (sourceVisible && source.fileName.startsWith(body.prefix))
        files.push(source)
      if (
        target?.action === "upload" &&
        target.fileName.startsWith(body.prefix)
      )
        files.push(target)
      return Response.json({
        files: files.slice(0, body.maxFileCount),
        nextFileName: null,
      })
    }
    if (operation === "b2_get_file_info") {
      if (body.fileId === source.fileId) return Response.json(source)
      if (body.fileId === "large-id" && target?.action === "upload")
        return Response.json(target)
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    if (operation === "b2_start_large_file") {
      target = {
        fileId: "large-id",
        fileName: body.fileName,
        contentLength: 0,
        action: "start",
      }
      return Response.json(target)
    }
    if (operation === "b2_copy_part") {
      partNumbers.push(body.partNumber)
      return Response.json({
        contentSha1: String(body.partNumber).padStart(40, "a"),
      })
    }
    if (operation === "b2_finish_large_file") {
      assert.equal(body.partSha1Array.length, Math.ceil(size / 1024 ** 3))
      target = {
        ...target,
        contentLength: size,
        contentSha1: "none",
        action: "upload",
      }
      finished = true
      return Response.json(target)
    }
    if (operation === "b2_hide_file") {
      sourceVisible = false
      return Response.json({ action: "hide" })
    }
    if (operation === "b2_delete_file_version") return Response.json({})
    throw new Error(`Unexpected B2 call: ${operation}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const storage = {
    id: 18,
    driver: "B2",
    mount_path: "/",
    addition: JSON.stringify({
      endpoint: "s3.us-west-004.backblazeb2.com",
      bucket: "bucket",
      access_key_id: "key",
      secret_access_key: "secret",
    }),
  }
  const env = { DB: db }
  const job = await startB2Rename(env, storage, "/old", "/old", "new")
  for (let i = 0; i < 15; i++) {
    if (!(await advanceB2Rename(env, storage, job.id))) break
  }
  assert.equal(finished, true)
  assert.deepEqual(partNumbers, [1, 2, 3, 4, 5])
  assert.equal(await getB2RenameJob(env, storage.id), null)
})
