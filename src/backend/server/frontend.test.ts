import assert from "node:assert/strict"
import { test } from "node:test"
import { serveFrontend } from "./frontend"
const shell = () => new Response("<!doctype html><title>OpenList</title>", { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } })
test("HTML entry routes always revalidate, including nested video routes", async () => {
  for (const path of ["/", "/index.html", "/B2/lesson.mp4"]) {
    const response = await serveFrontend(new Request("https://test.example" + path), { fetch: async () => shell() })
    assert.equal(response.headers.get("cache-control"), "no-cache, must-revalidate")
    assert.equal(response.status, 200)
  }
})
test("SPA fallback for a video URL also revalidates", async () => {
  const calls: string[] = []
  const response = await serveFrontend(new Request("https://test.example/B2/video.mp4"), { fetch: async (r) => { calls.push(new URL(r.url).pathname); return calls.length === 1 ? new Response("missing", { status: 404 }) : shell() } })
  assert.deepEqual(calls, ["/B2/video.mp4", "/"])
  assert.equal(response.headers.get("cache-control"), "no-cache, must-revalidate")
})
test("missing hashed modules are true noncached errors and never fetch the HTML shell", async () => {
  for (const provider of [() => shell(), () => new Response("missing", { status: 404 }), () => new Response("down", { status: 503 })]) {
    let calls = 0
    const response = await serveFrontend(new Request("https://test.example/assets/File-old.js"), { fetch: async () => { calls++; return provider() } })
    assert.equal(calls, 1)
    assert.ok(response.status >= 400)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.doesNotMatch(await response.text(), /doctype|OpenList/)
  }
})
test("successful versioned JS preserves its long-lived cache policy", async () => {
  const response = await serveFrontend(new Request("https://test.example/assets/File-new.js"), { fetch: async () => new Response("export default {}", { headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=31536000, immutable" } }) })
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable")
})
test("EdgeOne inline HTML does not masquerade as missing assets, including HEAD", async () => {
  const html = "<!doctype html>"
  assert.equal((await serveFrontend(new Request("https://test.example/assets/File-old.js"), undefined, html)).status, 404)
  const head = await serveFrontend(new Request("https://test.example/assets/old.css", { method: "HEAD" }), undefined, html)
  assert.equal(head.status, 404)
  assert.equal(await head.text(), "")
  assert.equal((await serveFrontend(new Request("https://test.example/B2/file.mp4"), undefined, html)).status, 200)
})


test("HTML conditional requests cannot retain an older long cache policy", async () => {
  const response = await serveFrontend(new Request("https://test.example/B2/video.mp4", { headers: { "If-None-Match": "old" } }), { fetch: async () => new Response(null, { status: 304, headers: { "Cache-Control": "public, max-age=3600", ETag: "old" } }) })
  assert.equal(response.status, 304)
  assert.equal(response.headers.get("cache-control"), "no-cache, must-revalidate")
})

const pdfPath = "/static/pdfjs/6.3.289-openlist3/web/viewer.html"
const pdfShell = () => new Response('<!doctype html><html data-openlist-pdf-viewer="range"><title>PDF</title></html>', { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } })
test("the local PDF viewer HTML is served without CDN rewriting", async () => {
  const response = await serveFrontend(new Request("https://test.example" + pdfPath), { fetch: async () => pdfShell() }, undefined, { ASSET_URLS: "https://cdn.example/dist" })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /data-openlist-pdf-viewer/)
  assert.equal(response.headers.get("cache-control"), "no-cache, must-revalidate")
  assert.equal(response.headers.get("location"), null)
})
test("PDF viewer HEAD and conditional responses verify the actual entry with GET", async () => {
  for (const method of ["HEAD", "GET"]) {
    const calls: Request[] = []
    const response = await serveFrontend(new Request("https://test.example" + pdfPath, { method, headers: { "If-None-Match": "old", "If-Modified-Since": "old" } }), { fetch: async (request) => { calls.push(request); return calls.length === 1 ? new Response(null, { status: method === "HEAD" ? 200 : 304 }) : pdfShell() } })
    assert.equal(response.status, 200)
    assert.equal(calls[1].method, "GET")
    assert.equal(calls[1].headers.get("if-none-match"), null)
    assert.equal(calls[1].headers.get("if-modified-since"), null)
    assert.equal(response.headers.get("cache-control"), "no-cache, must-revalidate")
    assert.equal((await response.text()).length === 0, method === "HEAD")
  }
})
test("a missing PDF viewer cannot become the SPA shell or redirect to the official CDN", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await serveFrontend(new Request("https://test.example" + pdfPath, { method }), { fetch: async () => shell() }, undefined, { ASSET_URLS: "https://cdn.example/dist" })
    assert.equal(response.status, 404)
    assert.equal(response.headers.get("location"), null)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.equal(await response.text(), "")
  }
})
