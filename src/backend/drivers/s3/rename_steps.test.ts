import assert from "node:assert/strict"
import { test } from "node:test"
import { S3Driver } from "./driver"
import { S3Client } from "./util"
const addition: any = {
  bucket: "bucket",
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  access_key_id: "id",
  secret_access_key: "secret",
  force_path_style: true,
  root_folder_path: "/",
  list_object_version: "v2",
}

test("folder rename moves nested objects across bounded requests and fresh drivers", async (t) => {
  const files = new Map(
    Array.from({ length: 30 }, (_, n) => [
      `old/sub/file${n}`,
      { size: n, etag: `etag${n}` },
    ]),
  )
  let calls = 0
  t.mock.method(globalThis, "fetch", async (input: any, init: RequestInit) => {
    calls++
    const url = new URL(input),
      key = decodeURIComponent(url.pathname).replace(/^\/bucket\//, "")
    if (init.method === "GET") {
      assert.equal(init.cache, "no-store")
      assert.equal(url.searchParams.get("max-keys"), "1")
      assert.equal(url.searchParams.get("list-type"), "2")
      const entry = [...files].find(([k]) =>
        k.startsWith(url.searchParams.get("prefix")!),
      )
      return new Response(
        `<ListBucketResult>${entry ? `<Contents><Key>${entry[0]}</Key><Size>${entry[1].size}</Size><ETag>"${entry[1].etag}"</ETag></Contents>` : ""}</ListBucketResult>`,
      )
    }
    if (init.method === "HEAD") {
      const file = files.get(key)
      return new Response(
        null,
        file
          ? {
              headers: {
                "content-length": String(file.size),
                etag: `"${file.etag}"`,
              },
            }
          : { status: 404 },
      )
    }
    if (init.method === "PUT") {
      const headers = new Headers(init.headers)
      const source = decodeURIComponent(
        headers.get("x-amz-copy-source")!,
      ).replace(/^bucket\//, "")
      const file = files.get(source)!
      assert.equal(headers.get("x-amz-copy-source-if-match"), `"${file.etag}"`)
      files.set(key, file)
      return new Response(
        `<CopyObjectResult><ETag>"${file.etag}"</ETag></CopyObjectResult>`,
      )
    }
    assert.equal(init.method, "DELETE")
    assert(files.has(key.replace(/^old\//, "new/")))
    files.delete(key)
    return new Response(null, { status: 204 })
  })
  assert.equal(
    await new S3Driver(addition).prepareRenameSteps("/old", "new"),
    true,
  )
  for (let n = 0; n < 30; n++) {
    calls = 0
    assert.deepEqual(await new S3Driver(addition).renameStep("/old", "new"), {
      done: false,
      processed: true,
    })
    assert(calls <= 5)
  }
  assert.deepEqual(await new S3Driver(addition).renameStep("/old", "new"), {
    done: true,
  })
  assert.equal([...files.keys()].filter((k) => k.startsWith("old/")).length, 0)
  assert.equal([...files.keys()].filter((k) => k.startsWith("new/")).length, 30)
})

test("copy HTTP 200 error or unfinished body never permits source deletion", async (t) => {
  t.mock.method(S3Client.prototype, "firstObject", async () => ({
    key: "old/a",
    size: 1,
    etag: "original",
  }))
  let deleted = false
  t.mock.method(S3Client.prototype, "deleteObject", async () => {
    deleted = true
  })
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        "<Error><Code>InternalError</Code><Message>copy failed</Message></Error>",
      ),
  )
  await assert.rejects(
    new S3Driver(addition).renameStep("old", "new"),
    /copy failed/,
  )
  assert.equal(deleted, false)
  let end!: () => void
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            end = () => {
              controller.enqueue(
                new TextEncoder().encode(
                  '<CopyObjectResult><ETag>"original"</ETag></CopyObjectResult>',
                ),
              )
              controller.close()
            }
          },
        }),
      ),
  )
  t.mock.method(S3Client.prototype, "headObject", async () => ({
    size: 1,
    etag: "original",
    modified: "",
  }))
  const pending = new S3Driver(addition).renameStep("old", "new")
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(deleted, false)
  end()
  await pending
  assert.equal(deleted, true)
})

test("source change and pre-existing destination retain original objects", async (t) => {
  t.mock.method(S3Client.prototype, "firstObject", async () => ({
    key: "old/a",
    size: 1,
    etag: "original",
  }))
  t.mock.method(S3Client.prototype, "copyObject", async () => "changed")
  t.mock.method(S3Client.prototype, "headObject", async () => ({
    size: 1,
    etag: "changed",
    modified: "",
  }))
  let deleted = false
  t.mock.method(S3Client.prototype, "deleteObject", async () => {
    deleted = true
  })
  await assert.rejects(
    new S3Driver(addition).renameStep("old", "new"),
    /Source changed/,
  )
  assert.equal(deleted, false)
  t.mock.method(S3Client.prototype, "headObject", async () => null)
  await assert.rejects(
    new S3Driver(addition).prepareRenameSteps("old", "new"),
    /已存在/,
  )
})

test("large object copy splits initiation, parts, completion and deletion into requests", async (t) => {
  const size = 6 * 1024 ** 3
  t.mock.method(S3Client.prototype, "firstObject", async () => ({
    key: "old/big",
    size,
    etag: "source",
  }))
  t.mock.method(
    S3Client.prototype,
    "createMultipartUpload",
    async () => "upload-id",
  )
  let parts = 0,
    completed = false,
    deleted = false
  t.mock.method(
    S3Client.prototype,
    "uploadCopyPart",
    async (
      _s: string,
      _d: string,
      _u: string,
      n: number,
      start: number,
      end: number,
    ) => {
      assert.equal(n, ++parts)
      assert.equal(end - start + 1, 1024 ** 3)
      return `part${n}`
    },
  )
  t.mock.method(
    S3Client.prototype,
    "completeMultipartUpload",
    async (_key: string, _id: string, p: string[]) => {
      assert.deepEqual(
        p,
        Array.from({ length: 6 }, (_, i) => `"part${i + 1}"`),
      )
      completed = true
    },
  )
  t.mock.method(S3Client.prototype, "headObject", async (key: string) => ({
    size,
    etag: key.startsWith("new/") ? "destination" : "source",
    modified: "",
  }))
  t.mock.method(S3Client.prototype, "deleteObject", async () => {
    assert(completed)
    deleted = true
  })
  let result = await new S3Driver(addition).renameStep("old", "new")
  for (let n = 0; n < 6; n++) {
    result = await new S3Driver(addition).renameStep("old", "new", result.copy)
    assert(!deleted)
  }
  result = await new S3Driver(addition).renameStep("old", "new", result.copy)
  assert(completed)
  assert(!deleted)
  result = await new S3Driver(addition).renameStep("old", "new", result.copy)
  assert.deepEqual(result, { done: false, processed: true })
  assert(deleted)
})

test("lost multipart completion response restarts copy without deleting the source", async (t) => {
  t.mock.method(S3Client.prototype, "completeMultipartUpload", async () => {
    throw new Error("NoSuchUpload")
  })
  t.mock.method(
    S3Client.prototype,
    "createMultipartUpload",
    async () => "replacement-upload",
  )
  t.mock.method(S3Client.prototype, "deleteObject", async () => {
    assert.fail("must not delete an unconfirmed source")
  })
  const copy = {
    key: "old/large",
    target: "new/large",
    size: 6 * 1024 ** 3,
    etag: "source",
    uploadId: "lost-upload",
    parts: Array.from({ length: 6 }, (_, i) => ({
      partNumber: i + 1,
      etag: `part${i + 1}`,
    })),
  }
  const result = await new S3Driver(addition).renameStep("old", "new", copy)
  assert.equal(result.done, false)
  assert.equal(result.copy?.uploadId, "replacement-upload")
  assert.deepEqual(result.copy?.parts, [])
})
