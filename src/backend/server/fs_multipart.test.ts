import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { sign } from "hono/jwt"
import { getDb, saveDb } from "../internal/model/db"
import { fsRouter } from "./fs"
import { publicRouter } from "./public"
import { uploadDatabase } from "../internal/upload/multipart.test-helper"

const MiB = 1024 * 1024
const token = "multipart-admin-token"
const addition = {
  bucket: "private-bucket",
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  region: "us-west-004",
  access_key_id: "test",
  secret_access_key: "test",
  root_folder_path: "/assets",
  force_path_style: true,
}
async function setup(t: any) {
  const db = uploadDatabase()
  const env = {
    DB: db,
    DB_DRIVER: "d1",
    DB_FORMAT: "sql",
    JWT_SECRET: "test-only-multipart-secret-32-characters",
  }
  await saveDb(
    {
      settings: [{ key: "token", value: token }],
      users: [
        { id: 1, username: "admin", role: 2, permission: 0, disabled: false },
        {
          id: 2,
          username: "writer",
          role: 0,
          permission: 8,
          disabled: false,
          base_path: "/B2",
        },
      ],
      storages: [
        {
          id: 1,
          driver: "S3",
          mount_path: "/B2",
          modified: "multipart-test",
          addition: JSON.stringify(addition),
        },
      ],
      metas: [],
      shares: [],
    },
    env,
  )
  const app = new Hono()
  app.route("/api/fs", fsRouter)
  app.route("/api/public", publicRouter)
  const providerCalls: { method: string; url: URL; body?: any }[] = []
  let completionFailures = 0
  let uploadCounter = 0
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    const url = new URL(String(input))
    assert.equal(url.hostname, "s3.us-west-004.backblazeb2.com")
    assert.ok(init.headers.Authorization || init.headers.authorization)
    providerCalls.push({ method: init.method, url, body: init.body })
    if (url.searchParams.has("uploads"))
      return new Response(
        "<InitiateMultipartUploadResult><UploadId>provider-id</UploadId></InitiateMultipartUploadResult>",
      )
    if (init.method === "PUT")
      return new Response(null, {
        headers: { ETag: `"part-${url.searchParams.get("partNumber")}"` },
      })
    if (init.method === "DELETE") return new Response(null, { status: 204 })
    if (completionFailures-- > 0)
      return new Response(
        "<Error><Code>InternalError</Code><Message>retry</Message></Error>",
      )
    return new Response(
      "<CompleteMultipartUploadResult><ETag>final</ETag></CompleteMultipartUploadResult>",
    )
  })
  const request = (
    endpoint: string,
    method = "POST",
    headers: any = {},
    body?: any,
    auth = token,
    binding = db,
  ) =>
    app.request(
      `/api/fs/multipart/${endpoint}`,
      { method, headers: { Authorization: auth, ...headers }, body },
      { ...env, DB: binding },
    )
  const init = async (
    size: number,
    chunk = 5 * MiB,
    path = "/B2/课程 #1.mp4",
  ) => {
    const response = await request("init", "POST", {
      "File-Path": encodeURIComponent(path),
      "X-File-Size": String(size),
      "X-Chunk-Size": String(chunk),
    })
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()).data
  }
  return {
    db,
    env,
    app,
    request,
    init,
    providerCalls,
    failCompletion: () => {
      completionFailures = 1
    },
  }
}

test("B2 multipart uploads out of order, resumes across cold bindings, completes with ordered ETags", async (t) => {
  const x = await setup(t)
  const size = 10 * MiB + 7
  const s = await x.init(size)
  assert.ok(s.upload_id)
  assert.equal(s.total_chunks, 3)
  const header = { "X-Upload-Id": s.upload_id }
  assert.equal((await x.request("complete", "POST", header)).status, 409)
  for (const index of [2, 0]) {
    const r = await x.request(
      "chunk",
      "PUT",
      { ...header, "X-Chunk-Index": String(index) },
      new Uint8Array(index === 2 ? 7 : 5 * MiB),
      token,
      uploadDatabase(x.db.sqlite),
    )
    assert.equal(r.status, 200, await r.clone().text())
  }
  const resumed = await x.init(size)
  assert.equal(resumed.resumed, true)
  assert.deepEqual(resumed.received, [
    [0, 0],
    [2, 2],
  ])
  assert.equal(resumed.received_bytes, 5 * MiB + 7)
  const result = await x.request(
    "chunk",
    "PUT",
    { ...header, "X-Chunk-Index": "1" },
    new Uint8Array(5 * MiB),
  )
  assert.equal(result.status, 200, await result.clone().text())
  x.failCompletion()
  assert.equal((await x.request("complete", "POST", header)).status, 500)
  const complete = await x.request(
    "complete",
    "POST",
    header,
    undefined,
    token,
    uploadDatabase(x.db.sqlite),
  )
  assert.equal(complete.status, 200, await complete.clone().text())
  assert.equal((await complete.json()).data.state, "completed")
  const posts = x.providerCalls.filter(
    (call) => call.method === "POST" && call.url.searchParams.has("uploadId"),
  )
  assert.ok(
    posts
      .at(-1)!
      .body.includes(
        "<PartNumber>1</PartNumber><ETag>&quot;part-1&quot;</ETag>",
      ),
  )
  assert.ok(
    posts.at(-1)!.body.indexOf("part-1") < posts.at(-1)!.body.indexOf("part-2"),
  )
  assert.ok(
    x.providerCalls.every(
      (call) =>
        call.url.pathname ===
        "/private-bucket/assets/%E8%AF%BE%E7%A8%8B%20%231.mp4",
    ),
  )
  const count = x.providerCalls.length
  assert.equal((await x.request("complete", "POST", header)).status, 200)
  assert.equal(x.providerCalls.length, count)
  const status = await x.request(
    `status?upload_id=${s.upload_id}`,
    "GET",
    {},
    undefined,
    token,
    uploadDatabase(x.db.sqlite),
  )
  assert.equal((await status.json()).data.state, "completed")
})

test("2.5 GiB init negotiates safe part sizes and public settings enable Multipart", async (t) => {
  const x = await setup(t)
  const s = await x.init(2.5 * 1024 ** 3, 64 * MiB)
  assert.equal(s.chunk_size, 16 * MiB)
  assert.equal(s.total_chunks, 160)
  const settings = await x.app.request("/api/public/settings", {}, x.env)
  const data = (await settings.json()).data
  assert.equal(data.multipart_enabled, "true")
  assert.equal(data.multipart_chunk_size, "10")
})

test("bad chunks, other owners and anonymous status cannot touch the provider; abort is durable", async (t) => {
  const x = await setup(t)
  const s = await x.init(10 * MiB)
  const h = { "X-Upload-Id": s.upload_id }
  const count = x.providerCalls.length
  for (const index of ["1.5", "NaN", "2", "-1"]) {
    assert.equal(
      (
        await x.request(
          "chunk",
          "PUT",
          { ...h, "X-Chunk-Index": index },
          new Uint8Array(1),
        )
      ).status,
      400,
    )
  }
  assert.equal(
    (
      await x.request(
        "chunk",
        "PUT",
        { ...h, "X-Chunk-Index": "0" },
        new Uint8Array(1),
      )
    ).status,
    400,
  )
  const other = await sign(
    { id: 2, exp: Math.floor(Date.now() / 1000) + 60 },
    x.env.JWT_SECRET,
    "HS256",
  )
  assert.equal(
    (await x.request("complete", "POST", h, undefined, other)).status,
    404,
  )
  assert.equal(
    (
      await x.request(
        `status?upload_id=${s.upload_id}`,
        "GET",
        {},
        undefined,
        "",
      )
    ).status,
    403,
  )
  assert.equal(x.providerCalls.length, count)
  assert.equal((await x.request("abort", "POST", h)).status, 200)
  assert.equal(x.providerCalls.at(-1)!.method, "DELETE")
  const status = await x.request(`status?upload_id=${s.upload_id}`, "GET")
  assert.equal((await status.json()).data.state, "aborted")
  assert.equal(
    (
      await x.request(
        "chunk",
        "PUT",
        { ...h, "X-Chunk-Index": "0" },
        new Uint8Array(5 * MiB),
      )
    ).status,
    409,
  )
})

test("concurrent initializations converge on one durable upload and abort the unused provider upload", async (t) => {
  const x = await setup(t)
  const [a, b] = await Promise.all([x.init(20 * MiB), x.init(20 * MiB)])
  assert.equal(a.upload_id, b.upload_id)
  assert.ok(a.resumed || b.resumed)
  assert.equal(
    x.providerCalls.filter((call) => call.method === "DELETE").length,
    1,
  )
})

test("existing disabled setting is respected and an oversized frontend threshold is capped", async (t) => {
  const x = await setup(t)
  const db = await getDb(x.env)
  db.settings = db.settings.filter(
    (s: any) => !["multipart_enabled", "multipart_chunk_size"].includes(s.key),
  )
  db.settings.push(
    { key: "multipart_enabled", value: "false" },
    { key: "multipart_chunk_size", value: "64" },
  )
  await saveDb(db, x.env)
  const response = await x.app.request(
    "/api/public/settings",
    {},
    { ...x.env, MAX_UPPART: String(8 * MiB) },
  )
  const settings = (await response.json()).data
  assert.equal(settings.multipart_enabled, "false")
  assert.equal(settings.multipart_chunk_size, "8")
})
