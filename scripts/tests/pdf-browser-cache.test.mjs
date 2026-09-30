import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { test } from "node:test"
import { PDF_VIEWER_PATH } from "../fetch-pdf-viewer.mjs"

// An actual viewer and actual Range responses catch Chromium's same-URL HTTP
// cache lock. Request interception disables that cache and hides the regression.
// Keep this test free of page.route/context.route and explicitly enable caching.
const { chromium } = await import(
  process.env.PDF_TEST_PLAYWRIGHT_MODULE || "playwright"
)
const dist = path.resolve(process.env.PDF_TEST_DIST || "dist")

function fixture() {
  const pages = 16
  let source = "%PDF-1.7\n",
    offsets = [0]
  const object = (id, value) => {
    offsets[id] = Buffer.byteLength(source)
    source += `${id} 0 obj\n${value}\nendobj\n`
  }
  object(1, "<< /Type /Catalog /Pages 2 0 R >>")
  object(
    2,
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
  )
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  for (let page = 0; page < pages; page++) {
    const id = 4 + page * 2
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
    )
    const content = `BT /F1 12 Tf 20 250 Td (Cache-enabled PDF page ${page + 1}) Tj ET\n`
    object(
      id + 1,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    )
    // Separate page dictionaries across 64 KiB ranges without giant images.
    source += `%${"padding".repeat(19000)}\n`
  }
  const xref = Buffer.byteLength(source)
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1))
    source += `${String(offset).padStart(10, "0")} 00000 n \n`
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(source)
}

test(
  "cache-enabled Chromium keeps signed PDF ranges concurrent across reloads",
  { timeout: 45000 },
  async (t) => {
    const pdf = fixture(),
      requests = []
    let active = 0,
      peak = 0
    const source = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*")
      res.setHeader(
        "Access-Control-Expose-Headers",
        "Content-Length, Content-Range, Accept-Ranges",
      )
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Headers", "Range")
        res.writeHead(204).end()
        return
      }
      const range = req.headers.range
      const match = range && /^bytes=(\d+)-(\d+)$/.exec(range)
      assert.ok(!range || match, "single byte range must remain unchanged")
      const begin = match ? Number(match[1]) : 0
      const end = match
        ? Math.min(Number(match[2]), pdf.length - 1)
        : pdf.length - 1
      res.statusCode = range ? 206 : 200
      res.setHeader("Content-Type", "application/pdf")
      res.setHeader("Content-Length", end - begin + 1)
      res.setHeader("Accept-Ranges", "bytes")
      res.setHeader("Cache-Control", "no-store")
      if (range)
        res.setHeader("Content-Range", `bytes ${begin}-${end}/${pdf.length}`)
      const record = { url: req.url, range, bytes: 0 }
      requests.push(record)
      if (range) peak = Math.max(peak, ++active)
      let interval,
        offset = begin,
        waitingForHeaders = !!range
      const delay = setTimeout(() => {
        if (waitingForHeaders) {
          active--
          waitingForHeaders = false
        }
        res.flushHeaders()
        interval = setInterval(() => {
          if (offset > end) {
            clearInterval(interval)
            res.end()
            return
          }
          const chunk = pdf.subarray(offset, Math.min(offset + 65536, end + 1))
          offset += chunk.length
          record.bytes += chunk.length
          res.write(chunk)
        }, 5)
      }, 150)
      res.once("close", () => {
        clearTimeout(delay)
        clearInterval(interval)
        if (waitingForHeaders) active--
      })
    })
    await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve))
    const signedPath = "/document.pdf?sign=opaque%2Btoken&expires=123"
    const fileUrl = `http://127.0.0.1:${source.address().port}${signedPath}`
    const mime = {
      ".html": "text/html",
      ".mjs": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".ftl": "text/plain",
      ".wasm": "application/wasm",
    }
    const viewer = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost")
      if (url.pathname === "/test.html") {
        res.setHeader("Content-Type", "text/html")
        res.end(
          `<!doctype html><iframe id="pdf" style="width:100vw;height:100vh;border:0" src="/${PDF_VIEWER_PATH}/web/viewer.html?locale=en-US&theme=light"></iframe><script>const frame=document.getElementById('pdf');addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==frame.contentWindow)return;if(event.data.type==='openlist:pdf:ready')frame.contentWindow.postMessage({type:'openlist:pdf:open',url:${JSON.stringify(fileUrl)},filename:'cache-test.pdf'},location.origin);});</script>`,
        )
        return
      }
      const file = path.join(dist, url.pathname)
      if (
        !file.startsWith(`${dist}${path.sep}`) ||
        !fs.existsSync(file) ||
        !fs.statSync(file).isFile()
      ) {
        res.writeHead(404).end()
        return
      }
      res.setHeader(
        "Content-Type",
        mime[path.extname(file)] || "application/octet-stream",
      )
      fs.createReadStream(file).pipe(res)
    })
    await new Promise((resolve) => viewer.listen(0, "127.0.0.1", resolve))
    let browser
    t.after(async () => {
      await browser?.close()
      await Promise.all(
        [source, viewer].map(
          (server) =>
            new Promise((resolve) => {
              server.close(resolve)
              server.closeAllConnections()
            }),
        ),
      )
    })
    browser = await chromium.launch({
      ...(process.env.PDF_BROWSER_EXECUTABLE
        ? { executablePath: process.env.PDF_BROWSER_EXECUTABLE }
        : {}),
      args: ["--no-sandbox"],
    })
    const page = await browser.newPage({
      viewport: { width: 1000, height: 700 },
    })
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Network.enable")
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false })
    const url = `http://127.0.0.1:${viewer.address().port}/test.html`
    for (let attempt = 0; attempt < 2; attempt++) {
      requests.length = 0
      peak = 0
      if (attempt) await page.reload()
      else await page.goto(url)
      await page.waitForSelector("iframe")
      const frame = await (
        await page.locator("iframe").elementHandle()
      ).contentFrame()
      // PDF.js may restore the last viewed page on reload; wait for the visible
      // page rather than assuming page one must be rendered off-screen.
      await frame.waitForFunction(
        () => {
          const viewer = window.PDFViewerApplication?.pdfViewer
          return (
            viewer?.getPageView(viewer.currentPageNumber - 1)
              ?.renderingState === 3
          )
        },
        null,
        { timeout: 12000 },
      )
      assert.equal(
        await frame.evaluate(
          () => window.PDFViewerApplication.pdfDocument.numPages,
        ),
        16,
      )
      assert.ok(
        peak >= 2,
        `HTTP cache must not serialize ranges; observed peak ${peak}`,
      )
      assert.ok(
        requests.every((request) => request.url === signedPath),
        "signed URL must remain exact",
      )
      const bytes = () =>
        requests.reduce((sum, request) => sum + request.bytes, 0)
      assert.ok(
        bytes() < pdf.length,
        "first page must not download the entire PDF",
      )
      let idle = bytes(),
        quietSince = Date.now()
      const deadline = Date.now() + 10000
      while (Date.now() - quietSince < 750 && Date.now() < deadline) {
        await page.waitForTimeout(100)
        if (active || bytes() !== idle) {
          idle = bytes()
          quietSince = Date.now()
        }
      }
      assert.ok(
        Date.now() - quietSince >= 750,
        "idle viewer must stop downloading",
      )
      assert.ok(
        idle < pdf.length,
        "idle viewer must not automatically download the full PDF",
      )
      await frame.evaluate(
        () => (window.PDFViewerApplication.pdfViewer.currentPageNumber = 16),
      )
      await frame.waitForFunction(
        () =>
          window.PDFViewerApplication.pdfViewer.getPageView(15)
            .renderingState === 3,
      )
      const count = requests.length
      const loaded = new Set(
        requests.map((request) => request.range).filter(Boolean),
      )
      await frame.evaluate(
        () => (window.PDFViewerApplication.pdfViewer.currentPageNumber = 1),
      )
      await frame.waitForFunction(
        () =>
          window.PDFViewerApplication.pdfViewer.getPageView(0)
            .renderingState === 3,
      )
      await page.waitForTimeout(300)
      assert.ok(
        requests
          .slice(count)
          .every((request) => request.range && !loaded.has(request.range)),
        "already loaded PDF ranges must stay in memory",
      )
      console.log(
        `cache enabled, load ${attempt + 1}: ${peak} concurrent ranges, ${idle}/${pdf.length} bytes`,
      )
    }
    assert.deepEqual(errors, [])
  },
)
