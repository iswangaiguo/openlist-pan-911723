import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { test } from "node:test"
import { patchPdfRangeFetch } from "../fetch-pdf-viewer.mjs"

const directory = process.env.PDF_VIEWER_DIR
if (!directory)
  throw new Error("Set PDF_VIEWER_DIR to the installed PDF.js directory")
const source = fs.readFileSync(path.join(directory, "build/pdf.mjs"), "utf8")
const start = source.indexOf("function fetchUrl(")
const end = source.indexOf("\nfunction ensureResponseStatus(", start)
assert.ok(start >= 0 && end > start, "PDF.js fetch helper must be recognized")
const helper = source.slice(start, end)

function harness(fetch) {
  return vm.runInNewContext(`${helper}\nfetchUrl`, { fetch })
}

test("actual deployed range fetch bypasses HTTP cache and preserves signed URL/options", async () => {
  const calls = []
  const response = new Response("range", { status: 206 })
  const fetchUrl = harness(async (url, options) => {
    calls.push({ url, options })
    return response
  })
  const url = new URL(
    "https://s3.example/a%20b.pdf?sign=opaque%2Btoken&expires=123",
  )
  for (const credentials of [false, true]) {
    const controller = new AbortController()
    const headers = new Headers({
      range: "bytes=65536-131071",
      "X-Custom": "keep",
    })
    assert.equal(
      await fetchUrl(url, headers, credentials, controller),
      response,
    )
    const call = calls.at(-1)
    assert.equal(call.url, url)
    assert.equal(call.options.cache, "no-store")
    assert.equal(call.options.headers, headers)
    assert.equal(call.options.headers.get("Range"), "bytes=65536-131071")
    assert.equal(call.options.headers.get("X-Custom"), "keep")
    assert.equal(call.options.signal, controller.signal)
    assert.equal(call.options.method, "GET")
    assert.equal(call.options.mode, "cors")
    assert.equal(call.options.redirect, "follow")
    assert.equal(
      call.options.credentials,
      credentials ? "include" : "same-origin",
    )
  }
})

test("initial and full-file fallback reads retain the default fetch cache policy", async () => {
  const fetchUrl = harness(async (_url, options) => {
    assert.equal(Object.hasOwn(options, "cache"), false)
    assert.equal(options.headers.has("Range"), false)
    return new Response("full document")
  })
  assert.equal(
    (
      await fetchUrl(
        new URL("https://s3.example/full.pdf"),
        new Headers(),
        false,
        new AbortController(),
      )
    ).status,
    200,
  )
})

test("range fetch forwards cancellation and network failure without swallowing errors", async () => {
  const fetchUrl = harness(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      }),
  )
  const controller = new AbortController()
  const pending = fetchUrl(
    new URL("https://s3.example/a.pdf"),
    new Headers({ Range: "bytes=0-65535" }),
    false,
    controller,
  )
  const reason = new Error("document closed")
  controller.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
  const failure = new Error("origin unavailable")
  await assert.rejects(
    harness(() => Promise.reject(failure))(
      new URL("https://s3.example/a.pdf"),
      new Headers(),
      false,
      new AbortController(),
    ),
    (error) => error === failure,
  )
})

test("range-fetch patch fails closed for changed or repeated upstream helpers", () => {
  const upstream = helper.replace(
    '    ...(headers.has("Range") ? { cache: "no-store" } : {}),\n',
    "",
  )
  assert.match(patchPdfRangeFetch(upstream), /cache: "no-store"/)
  for (const source of [
    "changed API",
    upstream + upstream,
    upstream.replace('redirect: "follow"', 'redirect: "manual"'),
    helper,
  ])
    assert.throws(
      () => patchPdfRangeFetch(source),
      /Unexpected PDF.js range fetch code/,
    )
})
