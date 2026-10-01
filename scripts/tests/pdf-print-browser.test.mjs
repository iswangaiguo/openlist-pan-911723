import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { test } from "node:test"
import { PDF_VIEWER_PATH } from "../fetch-pdf-viewer.mjs"

const { chromium } = await import(
  process.env.PDF_TEST_PLAYWRIGHT_MODULE || "playwright"
)
const dist = path.resolve(process.env.PDF_TEST_DIST || "dist")

function fixture() {
  const pages = 12,
    offsets = [0],
    contentOffsets = []
  let source = "%PDF-1.7\n"
  const object = (id, value) => {
    offsets[id] = Buffer.byteLength(source)
    source += `${id} 0 obj\n${value}\nendobj\n`
  }
  object(1, "<< /Type /Catalog /Pages 2 0 R >>")
  object(
    2,
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i} 0 R`).join(" ")}] >>`,
  )
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  for (let i = 0; i < pages; i++) {
    object(
      4 + i,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${4 + pages + i} 0 R >>`,
    )
  }
  // Page dictionaries fit in the header; page contents occupy distinct ranges.
  // Opening the last page's dictionary must not preload all print content.
  for (let i = 0; i < pages; i++) {
    source += `%${"padding".repeat(70000)}\n`
    const content = `BT /F1 12 Tf 20 250 Td (Print page ${i + 1}) Tj ET\n`
    contentOffsets.push(Buffer.byteLength(source))
    object(
      4 + pages + i,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    )
  }
  const xref = Buffer.byteLength(source)
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1))
    source += `${String(offset).padStart(10, "0")} 00000 n \n`
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return { bytes: Buffer.from(source), pages, contentOffsets }
}

test(
  "actual lazy PDF viewer prepares and prints with cancellation and retry",
  { timeout: 90000 },
  async (t) => {
    const pdf = fixture(),
      requests = [],
      alerts = [],
      errors = []
    let failOffset,
      failures = 0
    const mime = {
      ".html": "text/html",
      ".mjs": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".ftl": "text/plain",
      ".wasm": "application/wasm",
    }
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost")
      if (url.pathname === "/document.pdf") {
        const match =
          req.headers.range && /^bytes=(\d+)-(\d+)$/.exec(req.headers.range)
        const begin = match ? Number(match[1]) : 0
        const end = match
          ? Math.min(Number(match[2]), pdf.bytes.length - 1)
          : pdf.bytes.length - 1
        const record = { range: req.headers.range, url: req.url, bytes: 0 }
        requests.push(record)
        if (
          match &&
          failOffset !== undefined &&
          begin <= failOffset &&
          end >= failOffset
        ) {
          failOffset = undefined
          failures++
          res.writeHead(503).end("Temporary origin failure")
          return
        }
        res.statusCode = match ? 206 : 200
        res.setHeader("Content-Type", "application/pdf")
        res.setHeader("Content-Length", end - begin + 1)
        res.setHeader("Accept-Ranges", "bytes")
        res.setHeader("Cache-Control", "no-store")
        if (match)
          res.setHeader(
            "Content-Range",
            `bytes ${begin}-${end}/${pdf.bytes.length}`,
          )
        let interval,
          offset = begin
        const timer = setTimeout(() => {
          res.flushHeaders()
          interval = setInterval(() => {
            if (offset > end) {
              clearInterval(interval)
              res.end()
              return
            }
            const chunk = pdf.bytes.subarray(
              offset,
              Math.min(offset + 16384, end + 1),
            )
            offset += chunk.length
            record.bytes += chunk.length
            res.write(chunk)
          }, 3)
        }, 30)
        res.once("close", () => {
          clearTimeout(timer)
          clearInterval(interval)
        })
        return
      }
      if (url.pathname === "/test.html") {
        const file = `/document.pdf?sign=opaque%2Btoken&case=${url.searchParams.get("case")}`
        res.setHeader("Content-Type", "text/html")
        res.end(
          `<!doctype html><iframe style="width:100vw;height:95vh;border:0" src="/${PDF_VIEWER_PATH}/web/viewer.html?locale=en-US&theme=${url.searchParams.get("theme") || "light"}"></iframe><script>window.__fileUrl=${JSON.stringify(file)};const frame=document.querySelector('iframe');addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==frame.contentWindow)return;if(event.data.type==='openlist:pdf:ready')frame.contentWindow.postMessage({type:'openlist:pdf:open',url:window.__fileUrl,filename:'print-test.pdf'},location.origin);});</script>`,
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
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const browser = await chromium.launch({
      ...(process.env.PDF_BROWSER_EXECUTABLE
        ? { executablePath: process.env.PDF_BROWSER_EXECUTABLE }
        : {}),
      args: ["--no-sandbox"],
    })
    t.after(async () => {
      await browser.close()
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
    })
    async function open(name, options = {}) {
      const { theme, ...contextOptions } = options
      const page = await browser.newPage({
        viewport: { width: 1000, height: 720 },
        ...contextOptions,
      })
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (message) => {
        if (/Content Security Policy/i.test(message.text()))
          errors.push(message.text())
      })
      page.on("dialog", async (dialog) => {
        alerts.push(dialog.message())
        await dialog.dismiss()
      })
      // Stub only the final native print call; use the real viewer's print service,
      // rendered images, dialogs and network. No request routing/cache disabling.
      await page.addInitScript(() => {
        window.__nativePrints = []
        window.print = () => {
          const record = {
            pages: document.querySelectorAll(".printedPage img").length,
            loaded: [...document.querySelectorAll(".printedPage img")].every(
              (img) => img.complete && img.naturalWidth > 0,
            ),
          }
          window.__nativePrints.push(record)
          if (parent !== window) parent.__nativePrints.push(record)
        }
      })
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Network.enable")
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: false })
      await page.goto(
        `http://127.0.0.1:${server.address().port}/test.html?case=${name}&theme=${theme || "light"}`,
      )
      const frame = await (
        await page.locator("iframe").elementHandle()
      ).contentFrame()
      await frame.waitForFunction(
        () => {
          const viewer = window.PDFViewerApplication?.pdfViewer
          return (
            viewer?.getPageView(viewer.currentPageNumber - 1)
              ?.renderingState === 3 && viewer.printingAllowed
          )
        },
        null,
        { timeout: 12000 },
      )
      await frame.evaluate(
        () => window.PDFViewerApplication.pdfViewer.pagesPromise,
      )
      // Let adjacent visible-page rendering finish before spying on print reads.
      await frame.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 100)),
      )
      return { page, frame }
    }
    async function printed(frame, count = 1) {
      try {
        await frame.waitForFunction(
          (count) => window.__nativePrints.length === count,
          count,
          { timeout: 12000 },
        )
      } catch (error) {
        console.log(
          "Print failure state:",
          await frame.evaluate(() => {
            const app = window.PDFViewerApplication
            return {
              document: !!app.pdfDocument,
              task: !!app.pdfLoadingTask,
              pages: app.pdfViewer.pagesCount,
              ready: app.pdfViewer.pageViewsReady,
              printing: !!app.printService,
              dialog: document.querySelector("[data-openlist-print]")?.dataset
                .openlistPrint,
            }
          }),
        )
        throw error
      }
      assert.deepEqual(
        await frame.evaluate(() => window.__nativePrints.at(-1)),
        { pages: pdf.pages, loaded: true },
      )
      await frame.waitForFunction(
        () => !window.PDFViewerApplication.printService,
      )
    }
    await t.test(
      "unvisited pages print; preview stays lazy and a second print reuses data",
      async () => {
        const { page, frame } = await open("success")
        assert.equal(
          await frame.evaluate(
            () => window.PDFViewerApplication.pdfViewer.pageViewsReady,
          ),
          false,
        )
        assert.ok(
          requests
            .filter((r) => r.url.includes("case=success"))
            .reduce((n, r) => n + r.bytes, 0) <
            pdf.bytes.length / 3,
        )
        await frame.locator("#printButton").click()
        await printed(frame)
        assert.equal(
          await frame.evaluate(
            () => window.PDFViewerApplication.pdfViewer.pageViewsReady,
          ),
          true,
        )
        const count = requests.length
        await frame.locator("#printButton").click()
        await printed(frame, 2)
        assert.equal(requests.length, count, "PDF.js reuses loaded ranges")
        await page.close()
      },
    )
    await t.test(
      "duplicate clicks, cancellation and retry on a narrow dark viewport",
      async () => {
        const { page, frame } = await open("cancel", {
          viewport: { width: 390, height: 750 },
          theme: "dark",
        })
        await frame.evaluate(() => {
          const doc = window.PDFViewerApplication.pdfDocument
          window.__getPage = doc.getPage.bind(doc)
          window.__reads = 0
          const gate = new Promise((resolve) => {
            window.__release = resolve
          })
          doc.getPage = async (num) => {
            window.__reads++
            await gate
            return window.__getPage(num)
          }
          window.print()
          window.print()
        })
        await frame.locator('[data-openlist-print="loading"]').waitFor()
        assert.ok((await frame.evaluate(() => window.__reads)) <= 6)
        assert.equal(await frame.locator("[data-openlist-print]").count(), 1)
        const bounds = await frame
          .locator("[data-openlist-print]")
          .boundingBox()
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390)
        if (process.env.PDF_PRINT_SCREENSHOT_DIR)
          await page.screenshot({
            path: path.join(
              process.env.PDF_PRINT_SCREENSHOT_DIR,
              "pdf-print-dark-mobile.png",
            ),
          })
        await frame.locator("[data-cancel]").click()
        await frame.evaluate(() => window.__release())
        await frame.evaluate(
          () => new Promise((resolve) => setTimeout(resolve, 100)),
        )
        assert.equal(await frame.locator("[data-openlist-print]").count(), 0)
        assert.equal(
          await frame.evaluate(() => window.__nativePrints.length),
          0,
        )
        assert.ok(
          (await frame.evaluate(() => window.__reads)) < pdf.pages,
          "cancelled job starts no more reads",
        )
        await frame.evaluate(() => {
          window.PDFViewerApplication.pdfDocument.getPage = window.__getPage
          window.print()
        })
        await printed(frame)
        await page.close()
      },
    )
    await t.test(
      "cancelling print rendering keeps preview usable without a failure message",
      async () => {
        const { page, frame } = await open("render-cancel")
        await frame.locator("#printButton").click()
        await frame.locator("#printServiceDialog[open]").waitFor()
        await frame.locator("#printCancel").click()
        await frame.waitForFunction(
          () => !window.PDFViewerApplication.printService,
        )
        assert.equal(
          await frame.evaluate(() => window.__nativePrints.length),
          0,
        )
        assert.equal(await frame.locator("[data-openlist-print]").count(), 0)
        await frame.locator("#printButton").click()
        await printed(frame)
        await page.close()
      },
    )
    await t.test(
      "preparation failures show an actionable retry instead of an alert",
      async () => {
        const { page, frame } = await open("prepare-failure")
        await frame.evaluate(() => {
          const doc = window.PDFViewerApplication.pdfDocument,
            original = doc.getPage.bind(doc)
          let fail = true
          doc.getPage = (num) => {
            if (fail) {
              fail = false
              return Promise.reject(new Error("temporary page failure"))
            }
            return original(num)
          }
          window.print()
        })
        await frame.locator('[data-openlist-print="error"]').waitFor()
        assert.equal(
          await frame.evaluate(() => window.__nativePrints.length),
          0,
        )
        await frame.locator("[data-retry]").click()
        await printed(frame)
        await page.close()
      },
    )
    await t.test(
      "a real Range failure during print rendering can be retried",
      async () => {
        const { page, frame } = await open("range-failure")
        failOffset = pdf.contentOffsets[5]
        await frame.locator("#printButton").click()
        await frame
          .locator('[data-openlist-print="error"]')
          .waitFor({ timeout: 12000 })
        assert.equal(failures, 1)
        assert.equal(
          await frame.evaluate(() => window.__nativePrints.length),
          0,
        )
        await frame.locator("[data-retry]").click()
        await printed(frame)
        await page.close()
      },
    )
    await t.test(
      "switching the document while preparing does not print the old file",
      async () => {
        const { page, frame } = await open("switch")
        await frame.evaluate(() => {
          const app = window.PDFViewerApplication,
            original = app.pdfDocument.getPage.bind(app.pdfDocument)
          const gate = new Promise((resolve) => {
            window.__release = resolve
          })
          app.pdfDocument.getPage = async (num) => {
            await gate
            return original(num)
          }
          window.print()
        })
        await frame.locator('[data-openlist-print="loading"]').waitFor()
        await page.evaluate(() => {
          window.__fileUrl =
            "/document.pdf?sign=opaque%2Btoken&case=replacement"
          const frame = document.querySelector("iframe")
          frame.src += "&replacement=1"
        })
        await frame.waitForFunction(
          () =>
            location.search.includes("replacement=1") &&
            window.PDFViewerApplication?.pdfViewer?.getPageView(0)
              ?.renderingState === 3,
        )
        assert.equal(await frame.locator("[data-openlist-print]").count(), 0)
        assert.equal(await page.evaluate(() => window.__nativePrints.length), 0)
        assert.equal(
          await frame.evaluate(() => window.__nativePrints.length),
          0,
        )
        await frame.evaluate(() => {
          window.print()
        })
        await printed(frame)
        await page.close()
      },
    )
    assert.deepEqual(
      alerts,
      [],
      "printing must not produce the old not-ready alert",
    )
    assert.deepEqual(errors, [], "no browser errors or unhandled rejections")
  },
)
