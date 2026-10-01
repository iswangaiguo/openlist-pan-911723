import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
const { chromium } = await import(
  process.env.PDF_TEST_PLAYWRIGHT_MODULE || "playwright"
)
const dist = path.resolve(process.env.FRONTEND_BROWSER_DIST || "dist")

test(
  "built app handles hung startup reads and interrupted native video without losing position",
  { timeout: 120000 },
  async (t) => {
    const temp = fs.mkdtempSync(
      path.join(os.tmpdir(), "openlist-wake-browser-"),
    )
    const file = process.env.WAKE_BROWSER_MEDIA || path.join(temp, "wake.webm")
    if (!process.env.WAKE_BROWSER_MEDIA)
      execFileSync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=15",
        "-t",
        "120",
        "-an",
        "-c:v",
        "libvpx",
        "-b:v",
        "500k",
        "-deadline",
        "realtime",
        "-cpu-used",
        "5",
        "-g",
        "30",
        "-y",
        file,
      ])
    const video = fs.readFileSync(file),
      states = new Map(),
      errors = []
    const object = {
      name: "wake.webm",
      size: video.length,
      is_dir: false,
      type: 2,
      thumb: "",
      modified: "2026-10-01T00:00:00Z",
      created: "2026-10-01T00:00:00Z",
      sign: "0.test",
      provider: "S3",
      readme: "",
      header: "",
      related: [],
    }
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost")
      const name =
        url.searchParams.get("case") ||
        /(?:^|;)\s*test-case=([^;]+)/.exec(req.headers.cookie || "")?.[1]
      const state = states.get(name)
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname.endsWith("/public/settings")) {
          state.settings++
          if (state.hangSettings) return
        }
        let data = {}
        if (url.pathname.endsWith("/public/settings"))
          data = {
            backend: "ts-worker",
            site_title: "OpenList",
            version: "4.2.3",
            logo: "",
            main_color: "#0061ff",
            pagination_type: "all",
            search_index: "none",
            video_autoplay: "false",
            iframe_previews: "{}",
            external_previews: "{}",
          }
        else if (url.pathname.endsWith("/public/init_status"))
          data = { initialized: true }
        else if (url.pathname.endsWith("/public/archive_extensions")) data = []
        else if (url.pathname.endsWith("/me"))
          data = {
            id: 2,
            username: "guest",
            role: 1,
            permission: 0,
            base_path: "/",
            disabled: false,
            otp: false,
          }
        else if (url.pathname.endsWith("/fs/get")) {
          state.gets++
          if (state.hangFile) return
          if (state.gets > 1) state.block = false
          data = { ...object, raw_url: `/media.webm?case=${name}` }
        } else if (url.pathname.endsWith("/fs/list"))
          data = {
            content: [object],
            total: 1,
            readme: "",
            header: "",
            write: false,
            provider: "S3",
          }
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ code: 200, message: "success", data }))
        return
      }
      if (url.pathname === "/media.webm") {
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "")
        const begin = match ? Number(match[1]) : 0,
          end =
            match && match[2]
              ? Math.min(Number(match[2]), video.length - 1)
              : video.length - 1
        state.ranges.push({ begin, end })
        res.writeHead(match ? 206 : 200, {
          "Content-Type": "video/webm",
          "Content-Length": end - begin + 1,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          ...(match
            ? { "Content-Range": `bytes ${begin}-${end}/${video.length}` }
            : {}),
        })
        res.flushHeaders()
        if (state.block && begin < video.length - 262144) {
          // Preserve a live, stalled response, with no HTTP/media error event.
          if (begin === 0) res.write(video.subarray(0, 524288))
          return
        }
        res.end(video.subarray(begin, end + 1))
        return
      }
      let file = path.join(
        dist,
        url.pathname.replace("/__dynamic_base__/", "/"),
      )
      if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        file = path.join(dist, "index.html")
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".json": "application/json",
        }[path.extname(file)] || "application/octet-stream",
      )
      if (file.endsWith("index.html"))
        res.end(
          fs.readFileSync(file, "utf8").replaceAll("/__dynamic_base__/", "/"),
        )
      else fs.createReadStream(file).pipe(res)
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    let browser
    t.after(async () => {
      await browser?.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(temp, { recursive: true, force: true })
    })
    browser = await chromium.launch({
      ...(process.env.PDF_BROWSER_EXECUTABLE
        ? { executablePath: process.env.PDF_BROWSER_EXECUTABLE }
        : {}),
      args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
    })
    async function open(name, options = {}) {
      const state = {
        gets: 0,
        settings: 0,
        block: false,
        hangSettings: false,
        hangFile: false,
        ranges: [],
        ...options,
      }
      states.set(name, state)
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      })
      page.on("pageerror", (e) => errors.push(e.message))
      await page
        .context()
        .addCookies([{ name: "test-case", value: name, url: origin }])
      await page.clock.install({ time: new Date() })
      await page.goto(`${origin}/B2/wake.webm`, {
        waitUntil: "domcontentloaded",
      })
      return { page, state }
    }
    async function ready(page) {
      await page.waitForFunction(
        () => document.querySelector(".art-video")?.readyState >= 2,
        null,
        { timeout: 12000 },
      )
      assert.equal(await page.locator(".art-control-reconnect").count(), 1)
    }
    await t.test(
      "hung startup exits loading after 30 seconds and retries in place",
      async () => {
        const { page, state } = await open("startup", { hangSettings: true })
        while (!state.settings) await page.waitForTimeout(20)
        await page.clock.fastForward(31000)
        await page.getByText(/Request timed out/).waitFor({ timeout: 5000 })
        state.hangSettings = false
        await page.getByRole("button", { name: /Refresh|刷新/ }).click()
        await ready(page)
        await page.close()
      },
    )
    await t.test(
      "hung file information after sleep uses wall-time cancellation",
      async () => {
        const { page, state } = await open("metadata", { hangFile: true })
        await page.waitForFunction(
          () => !!document.querySelector(".drive-shell"),
        )
        while (!state.gets) await page.waitForTimeout(20)
        await page.clock.setSystemTime(new Date(Date.now() + 120000))
        await page.evaluate(() => document.dispatchEvent(new Event("resume")))
        await page.getByText(/Request timed out/).waitFor()
        state.hangFile = false
        await page.reload({ waitUntil: "domcontentloaded" })
        await ready(page)
        await page.close()
      },
    )
    await t.test(
      "a live stalled seek without an error recovers after a sleep-length clock interruption",
      async () => {
        const { page, state } = await open("freeze", { block: true })
        await ready(page)
        await page.evaluate(() => {
          const video = document.querySelector(".art-video")
          void video.play().catch(() => {})
          video.currentTime = 80
        })
        await page.waitForFunction(
          () => document.querySelector(".art-video").seeking,
        )
        assert.equal(
          await page.evaluate(() => document.querySelector(".art-video").error),
          null,
        )
        // The clock advances without running callbacks, like suspended timers.
        // Headless shell does not deliver freeze events for a visible page;
        // freeze/resume event handling is covered separately by source tests.
        await page.clock.setSystemTime(new Date(Date.now() + 120000))
        await page.evaluate(() => window.dispatchEvent(new Event("focus")))
        await page.clock.fastForward(1000)
        await page.clock.fastForward(16000)
        await page.waitForFunction(
          () => {
            const v = document.querySelector(".art-video")
            return (
              v.currentTime >= 79.5 &&
              !v.seeking &&
              v.readyState >= 3 &&
              !v.paused
            )
          },
          null,
          { timeout: 18000 },
        )
        assert.equal(
          state.gets,
          2,
          "one automatic metadata refresh; stable media URL is reused",
        )
        await page.waitForTimeout(400)
        assert.ok(
          (await page.evaluate(
            () => document.querySelector(".art-video").currentTime,
          )) > 80,
        )
        await page.close()
      },
    )
    await t.test(
      "dragging previews the destination and performs only one media seek on release",
      async () => {
        const { page, state } = await open("drag", { block: true })
        await ready(page)
        await page.evaluate(() => {
          window.seekCount = 0
          document
            .querySelector("video")
            .addEventListener("seeking", () => window.seekCount++)
        })
        const rect = await page.locator(".art-progress").boundingBox()
        const initialRequests = state.ranges.length
        await page.mouse.move(rect.x + 1, rect.y + rect.height / 2)
        await page.mouse.down()
        await page.mouse.move(
          rect.x + rect.width * 0.8,
          rect.y + rect.height / 2,
          { steps: 30 },
        )
        t.diagnostic(
          `drag while held: ${await page.evaluate(() => window.seekCount)} media seeks; ${state.ranges.length - initialRequests} additional media requests`,
        )
        assert.equal(
          await page.evaluate(
            () => document.querySelector("video").currentTime,
          ),
          0,
          "dragging must not read every intermediate file position",
        )
        assert.equal(await page.evaluate(() => window.seekCount), 0)
        assert.equal(state.ranges.length, initialRequests)
        await page.mouse.up()
        await page.waitForFunction(() => window.seekCount === 1)
        assert.ok(
          Math.abs(
            (await page.evaluate(
              () => document.querySelector("video").currentTime,
            )) - 96,
          ) < 0.2,
        )
        await page.waitForTimeout(100)
        assert.ok(state.ranges.length <= initialRequests + 3)
        await page.locator(".art-control-reconnect").click()
        await page.waitForFunction(() => {
          const v = document.querySelector("video")
          return (
            v.currentTime >= 95.5 && !v.seeking && v.readyState >= 2 && v.paused
          )
        })
        await page.evaluate(() => {
          window.seekCount = 0
        })
        await page.mouse.click(
          rect.x + rect.width * 0.4,
          rect.y + rect.height / 2,
        )
        await page.waitForFunction(() => window.seekCount === 1)
        assert.ok(
          Math.abs(
            (await page.evaluate(
              () => document.querySelector("video").currentTime,
            )) - 48,
          ) < 0.2,
        )
        await page.keyboard.press("ArrowRight")
        await page.waitForFunction(() => window.seekCount === 2)
        const beforeCancel = await page.evaluate(
          () => document.querySelector("video").currentTime,
        )
        assert.ok(
          Math.abs(beforeCancel - 53) < 0.2,
          "progress clicks preserve keyboard focus",
        )
        await page.mouse.move(
          rect.x + rect.width * 0.4,
          rect.y + rect.height / 2,
        )
        await page.mouse.down()
        await page.mouse.move(
          rect.x + rect.width * 0.7,
          rect.y + rect.height / 2,
          { steps: 10 },
        )
        await page.evaluate(() => window.dispatchEvent(new Event("blur")))
        await page.mouse.up()
        assert.equal(
          await page.evaluate(
            () => document.querySelector("video").currentTime,
          ),
          beforeCancel,
        )
        assert.equal(
          await page.evaluate(() => window.seekCount),
          2,
          "cancelled drag performs no seek",
        )
        await page.close()
      },
    )
    await t.test(
      "ordinary stalled seek does not reload; explicit reconnect restores position",
      async () => {
        const { page, state } = await open("manual", { block: true })
        await ready(page)
        await page.evaluate(() => {
          const video = document.querySelector(".art-video")
          video.pause()
          video.currentTime = 80
        })
        await page.waitForFunction(
          () => document.querySelector(".art-video").seeking,
        )
        await page.clock.runFor(20000)
        assert.equal(state.gets, 1, "normal buffering retains the source")
        await page.locator(".art-control-reconnect").click()
        await page.waitForFunction(
          () => {
            const v = document.querySelector(".art-video")
            return v.currentTime >= 79.5 && !v.seeking && v.readyState >= 2
          },
          null,
          { timeout: 18000 },
        )
        assert.equal(state.gets, 2)
        assert.equal(
          await page.evaluate(
            () => document.querySelector(".art-video").paused,
          ),
          true,
          "manual pause is preserved",
        )
        await page.close()
      },
    )
    assert.deepEqual(errors, [], "no unhandled browser exceptions")
  },
)
