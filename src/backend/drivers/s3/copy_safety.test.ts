import assert from "node:assert/strict"
import { test } from "node:test"
import { S3Driver } from "./driver"

type Obj = { size: number; etag: string }

const addition = {
  bucket: "bk",
  endpoint: "https://s3.example.com",
  region: "us-west-004",
  access_key_id: "id",
  secret_access_key: "secret",
  force_path_style: true,
}

const keyOf = (url: URL) =>
  url.pathname
    .split("/")
    .slice(2)
    .map(decodeURIComponent)
    .join("/")

/**
 * In-memory S3. `hooks` let a test inject failures or concurrent writes.
 */
function mockS3(
  objects: Map<string, Obj>,
  hooks: {
    completeBody?: string
    afterCopy?: (dst: string) => void
    dropCopies?: boolean
  } = {},
) {
  return async (input: any, init: any = {}) => {
    const url = new URL(String(input))
    const method = String(init.method || "GET").toUpperCase()
    const key = keyOf(url)
    const headers = new Headers(init.headers)
    if (method === "HEAD") {
      const obj = objects.get(key)
      return obj
        ? new Response(null, {
            headers: {
              "content-length": String(obj.size),
              etag: `"${obj.etag}"`,
            },
          })
        : new Response(null, { status: 404 })
    }
    if (method === "DELETE") {
      objects.delete(key)
      return new Response(null, { status: 204 })
    }
    if (method === "POST" && url.searchParams.has("uploads"))
      return new Response(
        "<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>",
      )
    if (method === "POST")
      return new Response(
        hooks.completeBody ??
          "<CompleteMultipartUploadResult><ETag>\"m\"</ETag></CompleteMultipartUploadResult>",
      )
    if (method === "PUT" && url.searchParams.has("partNumber"))
      return new Response('<CopyPartResult><ETag>"p"</ETag></CopyPartResult>')
    if (method === "PUT") {
      const source = decodeURIComponent(
        headers.get("x-amz-copy-source") || "",
      ).replace(/^bk\//, "")
      const src = objects.get(source)
      if (!src) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
      if (!hooks.dropCopies) objects.set(key, { ...src })
      hooks.afterCopy?.(key)
      return new Response(
        `<CopyObjectResult><ETag>"${src.etag}"</ETag></CopyObjectResult>`,
      )
    }
    // ListObjects v1 with delimiter
    const prefix = url.searchParams.get("prefix") || ""
    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
    const dirs = new Set<string>()
    let contents = ""
    for (const k of keys) {
      const rest = k.slice(prefix.length)
      if (rest.includes("/")) dirs.add(prefix + rest.split("/")[0] + "/")
      else {
        const o = objects.get(k)!
        contents += `<Contents><Key>${k}</Key><Size>${o.size}</Size><ETag>"${o.etag}"</ETag></Contents>`
      }
    }
    const prefixes = [...dirs]
      .map((d) => `<CommonPrefixes><Prefix>${d}</Prefix></CommonPrefixes>`)
      .join("")
    return new Response(
      `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}${prefixes}</ListBucketResult>`,
    )
  }
}

test("a >5GB rename keeps the source when completion fails inside a 200 response", async (t) => {
  const objects = new Map([["big.mkv", { size: 6_000_000_000, etag: "e1" }]])
  t.mock.method(
    globalThis,
    "fetch",
    mockS3(objects, {
      completeBody: "<Error><Code>InternalError</Code><Message>x</Message></Error>",
    }),
  )
  await assert.rejects(
    new S3Driver(addition as any).rename("/big.mkv", "/big.mkv", "new.mkv"),
    /InternalError/,
  )
  assert.ok(objects.has("big.mkv"))
})

test("a file move keeps the source when the copy cannot be confirmed", async (t) => {
  const objects = new Map([["a.txt", { size: 5, etag: "e1" }]])
  t.mock.method(globalThis, "fetch", mockS3(objects, { dropCopies: true }))
  await assert.rejects(
    new S3Driver(addition as any).move("/", "/d", ["a.txt"], "/a.txt", "/d/a.txt"),
    /source retained/,
  )
  assert.ok(objects.has("a.txt"))
})

test("a folder move never deletes files added to the source while copying", async (t) => {
  const objects = new Map([
    ["src/1.txt", { size: 1, etag: "a" }],
    ["src/sub/2.txt", { size: 2, etag: "b" }],
  ])
  let added = false
  t.mock.method(
    globalThis,
    "fetch",
    mockS3(objects, {
      afterCopy: () => {
        if (added) return
        added = true
        objects.set("src/late.txt", { size: 3, etag: "c" })
      },
    }),
  )
  await new S3Driver(addition as any).move("/", "/", ["src"], "/src", "/dst")
  assert.deepEqual(
    [...objects.keys()].sort(),
    ["dst/1.txt", "dst/sub/2.txt", "src/late.txt"],
  )
})

test("a folder move keeps a source file that changed after it was copied", async (t) => {
  const objects = new Map([["src/1.txt", { size: 1, etag: "a" }]])
  t.mock.method(
    globalThis,
    "fetch",
    mockS3(objects, {
      afterCopy: () => objects.set("src/1.txt", { size: 9, etag: "z" }),
    }),
  )
  await assert.rejects(
    new S3Driver(addition as any).move("/", "/", ["src"], "/src", "/dst"),
    /source retained/,
  )
  assert.ok(objects.has("src/1.txt"))
})
