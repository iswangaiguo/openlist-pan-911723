import assert from "node:assert/strict"
import { test } from "node:test"
import { S3Driver } from "./driver"
import { S3Client } from "./util"
const addition = {
  bucket: "private",
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  region: "us-west-004",
  access_key_id: "test",
  secret_access_key: "secret",
  root_folder_path: "/root",
  force_path_style: true,
}

test("driver sessions cannot be forged to target a different object or bucket", async (t) => {
  const calls: string[] = []
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    calls.push(String(url))
    return init.method === "POST"
      ? new Response(
          "<InitiateMultipartUploadResult><UploadId>opaque-upload-id</UploadId></InitiateMultipartUploadResult>",
        )
      : new Response(null, { headers: { ETag: '"part"' } })
  })
  const driver = new S3Driver(addition)
  const { session } = await driver.createUploadSession(
    "/B2",
    "/",
    "video.mp4",
    10,
    "",
  )
  await driver.uploadPart(session, 1, new Uint8Array(10))
  const parsed = JSON.parse(session)
  parsed.key = "outside.mp4"
  await assert.rejects(
    driver.uploadPart(JSON.stringify(parsed), 1, new Uint8Array(10)),
    /Invalid S3 upload session/,
  )
  await assert.rejects(
    new S3Driver({ ...addition, bucket: "other" }).uploadPart(
      session,
      1,
      new Uint8Array(10),
    ),
    /Invalid S3 upload session/,
  )
  assert.equal(calls.length, 2)
})

test("missing ETags and errors embedded in HTTP 200 are rejected", async (t) => {
  const client = new S3Client(addition)
  t.mock.method(globalThis, "fetch", async () => new Response(null))
  await assert.rejects(
    client.uploadPart("video.mp4", "id", 1, new Uint8Array(1)),
    /no ETag/,
  )
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        "<Error><Code>InvalidPart</Code><Message>missing part</Message></Error>",
      ),
  )
  await assert.rejects(
    client.completeMultipartUpload("video.mp4", "id", ['"part"']),
    /InvalidPart/,
  )
})

test("B2 streaming signs a small request, never hashes or buffers the part", async (t) => {
  const client = new S3Client(addition)
  const digestSizes: number[] = []
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  t.mock.method(crypto.subtle, "digest", async (algorithm: any, data: any) => {
    digestSizes.push(data.byteLength)
    return digest(algorithm, data)
  })
  const bytes = new Uint8Array(10 * 1024 * 1024)
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
  t.mock.method(globalThis, "fetch", async (rawUrl: any, init: any) => {
    const url = new URL(String(rawUrl))
    assert.equal(url.searchParams.get("partNumber"), "4")
    assert.equal(url.searchParams.get("uploadId"), "opaque")
    assert.equal(url.searchParams.get("X-Amz-Expires"), "600")
    assert.ok(url.searchParams.get("X-Amz-Signature"))
    assert.equal(init.body, stream)
    const reader = stream.getReader()
    assert.equal((await reader.read()).value, bytes)
    assert.equal((await reader.read()).done, true)
    return new Response(null, { headers: { ETag: '"streamed"' } })
  })
  assert.equal(
    await client.uploadPartStream("video.mp4", "opaque", 4, stream),
    '"streamed"',
  )
  assert.ok(digestSizes.length)
  assert.ok(
    digestSizes.every((size) => size < 2048),
    "part contents must never be hashed",
  )
  assert.equal(
    new S3Client({
      ...addition,
      endpoint: "http://s3.us-west-004.backblazeb2.com",
    }).supportsStreamingMultipart,
    false,
  )
  assert.equal(
    new S3Client({ ...addition, endpoint: "https://example.com" })
      .supportsStreamingMultipart,
    false,
  )
})
