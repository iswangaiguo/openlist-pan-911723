import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { saveDb } from "../internal/model/db"
import { signDownloadPath } from "../pkg/sign"
import { rawRouter } from "./raw"
import { b2RangeCachePolicy } from "./b2_range_cache"

const url = "https://s3.us-west-004.backblazeb2.com/test/movie.mp4"
const config = JSON.stringify({ url, etag: "version-one", size: 1000 })
test("range cache pilot requires an exact object and HEAD version", () => {
  const context = { config, etag: '"version-one"', size: 1000 }
  for (const range of ["bytes=100-103", "bytes=100-", "bytes=-4"]) {
    assert.equal(
      b2RangeCachePolicy(
        url + "?X-Amz-Signature=rotating",
        { Range: range },
        true,
        context,
      ).enabled,
      true,
    )
  }
  for (const variant of [
    { etag: "new-version" },
    { size: 999 },
    { config: "invalid" },
  ]) {
    assert.equal(
      b2RangeCachePolicy(url, { Range: "bytes=100-103" }, true, {
        ...context,
        ...variant,
      }).enabled,
      false,
    )
  }
  for (const range of ["", "bytes=0-1,5-6", "garbage"]) {
    assert.equal(
      b2RangeCachePolicy(url, { Range: range }, true, context).enabled,
      false,
    )
  }
  assert.equal(
    b2RangeCachePolicy(url + "x", { Range: "bytes=100-103" }, true, context)
      .target,
    false,
  )
})

test("cached ranges remain authenticated, signed to B2, and version checked", async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  const env = {
    DB_DRIVER: "memory",
    JWT_SECRET: "range-pilot-tests",
    B2_RANGE_CACHE_PILOT: config,
  }
  await saveDb(
    {
      settings: [{ key: "sign_all", value: "true" }],
      users: [],
      shares: [],
      metas: [],
      storages: [
        {
          id: 1,
          mount_path: "/test",
          driver: "S3",
          web_proxy: true,
          addition: JSON.stringify({
            endpoint: new URL(url).origin,
            bucket: "test",
            region: "us-west-004",
            access_key_id: "test",
            secret_access_key: "test",
            force_path_style: true,
          }),
        },
      ],
    },
    env,
  )
  const app = new Hono()
  app.route("/api/p", rawRouter)
  const calls: any[] = []
  let headVersion = "version-one",
    bodyVersion = "version-one"
  globalThis.fetch = async (input, init: any = {}) => {
    calls.push(init)
    if (init.method === "HEAD")
      return new Response(null, {
        headers: { "Content-Length": "1000", ETag: headVersion },
      })
    assert.ok(new URL(String(input)).searchParams.has("X-Amz-Signature"))
    return new Response("abcd", {
      status: 206,
      headers: {
        "Content-Range": "bytes 100-103/1000",
        "Content-Length": "4",
        ETag: bodyVersion,
        "CF-Cache-Status": "HIT",
        "Cache-Control": "public, max-age=3600",
      },
    })
  }
  const path = "/test/movie.mp4"
  const signed = await signDownloadPath({ env }, path, 60)
  const read = (sign?: string) =>
    app.request(
      `/api/p${path}${sign ? `?sign=${sign}` : ""}`,
      { headers: { Range: "bytes=100-103" } },
      env,
    )
  for (const sign of [
    undefined,
    "bad",
    await signDownloadPath({ env }, path, -1),
  ]) {
    const res = await read(sign)
    assert.equal(res.status, 401)
  }
  assert.equal(calls.length, 0)
  let res = await read(signed)
  assert.equal(res.status, 206)
  assert.equal(await res.text(), "abcd")
  assert.equal(res.headers.get("X-OpenList-Range-Cache"), "HIT")
  assert.equal(res.headers.get("Cache-Control"), "private, no-store")
  assert.equal(calls[0].cache, "no-store")
  assert.equal(calls[1].cf.cacheTtlByStatus["200-299"], 3600)
  assert.equal(calls[1].cf.cacheTtlByStatus["300-599"], -1)
  assert.equal(new Headers(calls[1].headers).get("range"), "bytes=100-103")
  calls.length = 0
  headVersion = "version-two"
  res = await read(signed)
  await res.text()
  assert.equal(calls[1].cache, "no-store", "changed object must bypass cache")
  calls.length = 0
  headVersion = "version-one"
  bodyVersion = "version-two"
  res = await read(signed)
  await res.text()
  assert.equal(res.headers.get("X-OpenList-Range-Cache"), "BYPASS-VERSION")
  assert.equal(calls.length, 3)
  assert.equal(calls[2].cache, "no-store")
})
