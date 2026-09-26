import assert from "node:assert/strict"
import { test } from "node:test"
import { S3Client } from "./util"

const client = () =>
  new S3Client({
    bucket: "private-bucket",
    endpoint: "https://s3.example.com",
    region: "us-west-004",
    access_key_id: "test-id",
    secret_access_key: "test-secret",
    force_path_style: true,
  })

test("signed HEAD bypasses the cold edge cache and reads metadata on the first attempt", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: any, init: RequestInit) => {
      assert.equal(init.method, "HEAD")
      assert.match(
        new Headers(init.headers).get("authorization") || "",
        /^AWS4-HMAC-SHA256 /,
      )
      // Simulate the method rewrite performed by a cold Cloudflare cache.
      if (init.cache !== "no-store") return new Response(null, { status: 403 })
      return new Response(null, {
        headers: {
          "content-length": "12345",
          "last-modified": "Wed, 23 Sep 2026 12:00:00 GMT",
          etag: '"test-etag"',
        },
      })
    },
  )
  assert.deepEqual(await client().headObject("中文/preview.pdf"), {
    size: 12345,
    modified: "Wed, 23 Sep 2026 12:00:00 GMT",
    etag: "test-etag",
  })
  assert.equal(fetchMock.mock.callCount(), 1)
})

test("HEAD still reports missing objects and genuine access failures", async (t) => {
  let status = 404
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status }))
  assert.equal(await client().headObject("missing.pdf"), null)
  status = 403
  await assert.rejects(client().headObject("denied.pdf"), /HTTP 403/)
})

test("listing GET requests retain their existing cache behavior", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: any, init: RequestInit) => {
    assert.equal(init.method, "GET")
    assert.equal(init.cache, undefined)
    return new Response(
      "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>",
    )
  })
  assert.deepEqual(await client().listObjects("", "v2"), [])
})

test("metadata listing bypasses edge cache and does not mint download URLs", async (t) => {
  const { S3Driver } = await import("./driver")
  const driver = new S3Driver({
    endpoint: "https://s3.example.com",
    bucket: "bucket",
    region: "us-east-1",
    access_key_id: "test",
    secret_access_key: "test",
    force_path_style: true,
  })
  t.mock.method(globalThis, "fetch", async (_input: any, init: RequestInit) => {
    assert.equal(init.cache, "no-store")
    return new Response(
      "<ListBucketResult><Contents><Key>lesson.mp4</Key><Size>12</Size><LastModified>2026-09-26T00:00:00Z</LastModified></Contents></ListBucketResult>",
    )
  })
  const items = await driver.listMetadata("/", "/")
  assert.equal(items[0].name, "lesson.mp4")
  assert.equal(items[0].raw_url, undefined)
  assert.equal(items[0].sign, "")
})
