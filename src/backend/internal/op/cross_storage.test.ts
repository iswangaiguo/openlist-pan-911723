import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { copyItems, moveItems } from "./storage"
import {
  saveDb,
  __setStoreBackendLoaderForTest,
  __resetDbCacheForTest,
} from "../model/db"

type Obj = { size: number; etag: string }
const ENDPOINT = "https://s3.example.com"
// Drivers are cached per storage id + revision; keep every mount distinct.
let revision = 0

const s3 = (id: number, mount: string, bucket: string, extra: any = {}) => ({
  id,
  driver: "S3",
  mount_path: mount,
  status: "work",
  modified: `cross-storage-test-${++revision}`,
  addition: {
    bucket,
    endpoint: ENDPOINT,
    region: "us-east-1",
    access_key_id: "key",
    secret_access_key: "secret",
    force_path_style: true,
    ...extra,
  },
})

/** Multi-bucket in-memory S3; objects are keyed "bucket/key". */
async function setup(t: TestContext, storages: any[], files: string[]) {
  const objects = new Map<string, Obj>(
    files.map((f, i) => [f, { size: i + 1, etag: `e${i}` }]),
  )
  const copies: string[] = []
  let data: any = {
    settings: [],
    users: [],
    storages,
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
  t.mock.method(globalThis, "fetch", async (input: any, init: any = {}) => {
    const url = new URL(String(input))
    const method = String(init.method || "GET").toUpperCase()
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent)
    const bucket = parts[0]
    const key = parts.slice(1).join("/")
    const full = `${bucket}/${key}`
    const headers = new Headers(init.headers)
    if (method === "HEAD") {
      const o = objects.get(full)
      return o
        ? new Response(null, {
            headers: { "content-length": String(o.size), etag: `"${o.etag}"` },
          })
        : new Response(null, { status: 404 })
    }
    if (method === "DELETE") {
      objects.delete(full)
      return new Response(null, { status: 204 })
    }
    if (method === "PUT") {
      const source = decodeURIComponent(headers.get("x-amz-copy-source") || "")
      const o = objects.get(source)
      if (!o)
        return new Response("<Error><Code>NoSuchKey</Code></Error>", {
          status: 404,
        })
      copies.push(`${source} -> ${full}`)
      objects.set(full, { ...o })
      return new Response(
        `<CopyObjectResult><ETag>"${o.etag}"</ETag></CopyObjectResult>`,
      )
    }
    const prefix = url.searchParams.get("prefix") || ""
    const dirs = new Set<string>()
    let contents = ""
    for (const [k, o] of [...objects].sort()) {
      if (!k.startsWith(`${bucket}/${prefix}`)) continue
      const rel = k.slice(bucket.length + 1)
      const rest = rel.slice(prefix.length)
      if (rest.includes("/")) dirs.add(prefix + rest.split("/")[0] + "/")
      else
        contents += `<Contents><Key>${rel}</Key><Size>${o.size}</Size><ETag>"${o.etag}"</ETag></Contents>`
    }
    const prefixes = [...dirs]
      .map((d) => `<CommonPrefixes><Prefix>${d}</Prefix></CommonPrefixes>`)
      .join("")
    return new Response(
      `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}${prefixes}</ListBucketResult>`,
    )
  })
  return { objects, copies }
}

test("moving between storages with different credentials is refused untouched", async (t) => {
  const { objects, copies } = await setup(
    t,
    [s3(1, "/A", "a"), s3(2, "/B", "b", { access_key_id: "other" })],
    ["a/f.txt"],
  )
  await assert.rejects(
    moveItems("/A", "/B", ["f.txt"]),
    /between different storages is not supported/,
  )
  assert.deepEqual([...objects.keys()], ["a/f.txt"])
  assert.deepEqual(copies, [])
})

test("same-account buckets move server-side into the destination bucket", async (t) => {
  const { objects, copies } = await setup(
    t,
    [s3(1, "/A", "a"), s3(2, "/B", "b", { root_folder_path: "/media" })],
    ["a/f.txt", "a/dir/1.txt", "a/dir/sub/2.txt"],
  )
  await moveItems("/A", "/B", ["f.txt", "dir"])
  assert.deepEqual([...objects.keys()].sort(), [
    "b/media/dir/1.txt",
    "b/media/dir/sub/2.txt",
    "b/media/f.txt",
  ])
  assert.ok(copies.includes("a/f.txt -> b/media/f.txt"))
})

test("same-account copy keeps the source", async (t) => {
  const { objects } = await setup(
    t,
    [s3(1, "/A", "a"), s3(2, "/B", "a", { root_folder_path: "/backup" })],
    ["a/dir/1.txt"],
  )
  await copyItems("/A", "/B", ["dir"])
  assert.deepEqual([...objects.keys()].sort(), [
    "a/backup/dir/1.txt",
    "a/dir/1.txt",
  ])
})

test("a folder cannot be copied into itself through another mount", async (t) => {
  const { objects } = await setup(
    t,
    [s3(1, "/A", "a"), s3(2, "/B", "a", { root_folder_path: "/dir" })],
    ["a/dir/1.txt"],
  )
  await assert.rejects(copyItems("/A", "/B", ["dir"]), /into itself/)
  assert.deepEqual([...objects.keys()], ["a/dir/1.txt"])
})
