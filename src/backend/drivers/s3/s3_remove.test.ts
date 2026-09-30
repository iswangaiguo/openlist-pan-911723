import assert from "node:assert/strict"
import { test } from "node:test"
import { S3Driver } from "./driver"
import { S3Client } from "./util"
import { CryptDriver } from "../crypt/driver"
import { ChunkDriver } from "../chunk/driver"

/**
 * 调用约定（src/backend/internal/op/storage.ts 的 removeItems/moveItems/copyItems）：
 *
 *   const resolved = await resolvePath(`${dir}/${name}`)
 *   await driver.remove(virtualPath, resolved.physical, [name])
 *
 * 即 physicalPath 是【目标项自身】的物理路径（文件路径），与 123pan/github/
 * azure_blob 等 driver 的用法一致。driver 不得再把 name 拼接到 physicalPath 后面，
 * 否则会得到 `<file>/<name>` 这种不存在的 key：HEAD 404 → 退化成按目录递归删 →
 * prefix 同样查不到任何对象 → 静默返回成功（接口报 success，对象仍在）。
 */

type Call = { method: string; url: string }

/** 内存版 S3：object key 存 URL pathname，记录所有请求以便断言目标 key */
function mockS3(objects: Set<string>, calls: Call[]) {
  return async (input: any, init: any = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url))
    const method = String(init.method || "GET").toUpperCase()
    calls.push({ method, url: url.toString() })

    if (method === "HEAD") {
      if (objects.has(url.pathname)) {
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": "10",
            etag: '"etag"',
            "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT",
          },
        })
      }
      return new Response(null, { status: 404 })
    }
    if (method === "DELETE") {
      objects.delete(url.pathname)
      return new Response(null, { status: 204 })
    }
    if (method === "PUT") {
      objects.add(url.pathname)
      return new Response(
        '<CopyObjectResult><ETag>"etag"</ETag></CopyObjectResult>',
        {
          headers: { "content-type": "application/xml" },
        },
      )
    }
    return new Response(
      `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`,
      { status: 200, headers: { "content-type": "application/xml" } },
    )
  }
}

function withMock<T>(
  objects: Set<string>,
  calls: Call[],
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = mockS3(objects, calls) as any
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

function makeDriver() {
  return new S3Driver({
    bucket: "mybucket",
    endpoint: "https://s3.amazonaws.com",
    access_key_id: "key",
    secret_access_key: "secret",
  })
}

const FILE_KEY = "/Cloudflare%20R2/AzkiDeck.html"

test("S3 remove() deletes the object key itself, not <file>/<name>", async () => {
  const objects = new Set([FILE_KEY])
  const calls: Call[] = []

  await withMock(objects, calls, () =>
    makeDriver().remove(
      "/Cloudflare R2/AzkiDeck.html",
      "/Cloudflare R2/AzkiDeck.html",
      ["AzkiDeck.html"],
    ),
  )

  assert.equal(
    objects.size,
    0,
    "object must be deleted (interface reported success)",
  )
  const deletes = calls
    .filter((c) => c.method === "DELETE")
    .map((c) => new URL(c.url).pathname)
  assert.ok(
    deletes.includes(FILE_KEY),
    `DELETE must target ${FILE_KEY}, got: ${deletes.join(", ") || "(none)"}`,
  )
})

test("Crypt over S3 deletes the suffixed object rather than appending its display name", async () => {
  const key = "/encrypted/movie.mp4.bin"
  const objects = new Set([key])
  const calls: Call[] = []
  const driver = new CryptDriver({ remote_path: "/S3", password: "test" })
  // Bind a real S3 driver without the unrelated database/key-derivation setup.
  Object.assign(driver, {
    remoteDriver: makeDriver(),
    remoteRoot: "/encrypted",
    cipher: {},
  })
  await withMock(objects, calls, () =>
    driver.remove("/Crypt/movie.mp4", "/movie.mp4", ["movie.mp4"]),
  )
  assert.equal(objects.size, 0)
  assert.deepEqual(
    calls
      .filter((c) => c.method === "DELETE")
      .map((c) => new URL(c.url).pathname),
    [key],
  )
})

test("Chunk over S3 deletes the chunk directory's contents without appending its display name", async (t) => {
  const dir = "parts/[openlist_chunk]movie.mp4"
  const deleted: string[] = []
  t.mock.method(S3Client.prototype, "listPrefixProbe", async () => false)
  t.mock.method(S3Client.prototype, "headObject", async (key: string) => {
    if (key === `${dir}/0` || key === `${dir}/1`)
      return { size: 5, isFolder: false }
    return null
  })
  t.mock.method(S3Client.prototype, "listObjects", async (key: string) => {
    if (key === dir)
      return [0, 1].map((n) => ({ name: String(n), size: 5, isFolder: false }))
    return []
  })
  t.mock.method(S3Client.prototype, "deleteObject", async (key: string) => {
    deleted.push(key)
  })
  const driver = new ChunkDriver({ remote_path: "/S3", part_size: 5 })
  Object.assign(driver, { remoteDriver: makeDriver(), remoteRoot: "/parts" })
  await driver.remove("/Chunk/movie.mp4", "/movie.mp4", ["movie.mp4"])
  assert.ok(deleted.includes(`${dir}/0`))
  assert.ok(deleted.includes(`${dir}/1`))
  assert.ok(deleted.every((key) => key.startsWith(`${dir}/`)))
  assert.ok(deleted.every((key) => !key.includes("movie.mp4/movie.mp4")))
})

test("S3 move() copies from / to the object key itself", async () => {
  const objects = new Set([FILE_KEY])
  const calls: Call[] = []

  await withMock(objects, calls, () =>
    makeDriver().move(
      "/Cloudflare R2",
      "/Cloudflare R2/bak",
      ["AzkiDeck.html"],
      "/Cloudflare R2/AzkiDeck.html",
      "/Cloudflare R2/bak/AzkiDeck.html",
    ),
  )

  const deletes = calls
    .filter((c) => c.method === "DELETE")
    .map((c) => new URL(c.url).pathname)
  const puts = calls
    .filter((c) => c.method === "PUT")
    .map((c) => new URL(c.url).pathname)
  assert.ok(
    deletes.includes(FILE_KEY),
    `move must delete source key ${FILE_KEY}, got: ${deletes.join(", ") || "(none)"}`,
  )
  assert.ok(
    puts.includes("/Cloudflare%20R2/bak/AzkiDeck.html"),
    `move must write destination key, got: ${puts.join(", ") || "(none)"}`,
  )
})
