import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { saveDb } from "../internal/model/db"
import { signDownloadPath } from "../pkg/sign"
import { rawRouter } from "./raw"

test("B2 video proxy bypasses cold cache while preserving ranges and authentication", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const env = { DB_DRIVER: "memory", JWT_SECRET: "range-regression-only" }
  const app = new Hono()
  app.route("/api/p", rawRouter)
  const calls: {
    url: string
    method: string
    cache?: RequestCache
    range: string | null
  }[] = []
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    const method = init.method || "GET"
    const range = new Headers(init.headers).get("range")
    calls.push({ url, method, cache: init.cache, range })
    if (method === "HEAD")
      return new Response(null, { headers: { "Content-Length": "1000" } })
    assert.ok(
      new URL(url).searchParams.has("X-Amz-Signature"),
      "B2/S3 origin must remain signed",
    )
    if (range)
      return new Response("abcd", {
        status: 206,
        headers: {
          "Content-Range": "bytes 100-103/1000",
          "Content-Length": "4",
          "Accept-Ranges": "bytes",
        },
      })
    return new Response("full")
  }
  let id = 0
  for (const [host, filename, range, expectedCache] of [
    [
      "s3.us-west-004.backblazeb2.com",
      "movie.mp4",
      "bytes=100-103",
      "no-store",
    ],
    ["s3.us-west-004.backblazeb2.com", "image.png", "bytes=100-103", undefined],
    ["s3.us-west-004.backblazeb2.com", "movie.mp4", undefined, undefined],
    ["s3.example.com", "movie.mp4", "bytes=100-103", undefined],
    ["s3.backblazeb2.com.example.com", "movie.mp4", "bytes=100-103", undefined],
  ] as const) {
    await saveDb(
      {
        settings: [{ key: "sign_all", value: "true" }],
        users: [],
        shares: [],
        metas: [],
        storages: [
          {
            id: ++id,
            mount_path: "/test",
            driver: "S3",
            web_proxy: true,
            addition: JSON.stringify({
              endpoint: `https://${host}`,
              bucket: "test",
              region: "us-west-004",
              access_key_id: "test-only",
              secret_access_key: "test-only",
              force_path_style: true,
            }),
          },
        ],
      },
      env,
    )
    calls.length = 0
    const path = `/test/${filename}`
    const headers = range ? { Range: range } : {}
    const rejected = await app.request(`/api/p${path}`, { headers }, env)
    assert.equal(rejected.status, 401)
    assert.equal(calls.length, 0, "unsigned requests must not reach B2")
    const sign = await signDownloadPath({ env }, path, 60)
    const res = await app.request(
      `/api/p${path}?sign=${sign}`,
      { headers },
      env,
    )
    assert.equal(res.status, range ? 206 : 200)
    assert.equal(await res.text(), range ? "abcd" : "full")
    if (range) {
      assert.equal(res.headers.get("Content-Range"), "bytes 100-103/1000")
      assert.equal(res.headers.get("Content-Length"), "4")
    }
    const reads = calls.filter((c) => c.method === "GET")
    assert.equal(reads.length, 1)
    assert.equal(reads[0].range, range || null)
    assert.equal(reads[0].cache, expectedCache, `${host}/${filename}`)
    assert.equal(calls.find((c) => c.method === "HEAD")?.cache, "no-store")
  }
})
