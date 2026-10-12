import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { createSearchFixture } from "./helpers/frontend-search-fixture.mjs"
const { chromium } = await import(
  process.env.PDF_TEST_PLAYWRIGHT_MODULE || "playwright"
)

test(
  "home keeps actions usable across desktop, mobile, selection and themes",
  { timeout: 60000 },
  async () => {
    const fixture = createSearchFixture(
      path.resolve(process.env.FRONTEND_BROWSER_DIST || "dist"),
      { permission: 8 },
    )
    await new Promise((resolve) =>
      fixture.server.listen(0, "127.0.0.1", resolve),
    )
    let browser
    try {
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      })
      const errors = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(`http://127.0.0.1:${fixture.server.address().port}/`)
      await page.locator(".drive-file-row").first().waitFor()
      assert.equal(await page.locator(".drive-item-count").innerText(), "2")
      const before = await page.locator(".drive-main").boundingBox()
      await page
        .getByRole("button", { name: "Collapse sidebar", exact: true })
        .click()
      assert.ok(
        (await page.locator(".drive-main").boundingBox()).width > before.width,
      )
      await page
        .getByRole("button", { name: "Expand sidebar", exact: true })
        .click()
      await page
        .getByRole("checkbox", { name: "Select all", exact: true })
        .check()
      assert.equal(await page.locator(".drive-file-section").count(), 0)
      await page
        .getByRole("checkbox", { name: "Select all", exact: true })
        .uncheck()
      const screenshotDir = process.env.HOME_SCREENSHOT_DIR
      if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true })
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 })
        assert.ok(await page.locator(".drive-heading-upload span").isVisible())
        assert.ok(await page.locator(".drive-heading-mkdir span").isVisible())
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          `overflow at ${width}`,
        )
        const upload = await page.locator(".drive-heading-upload").boundingBox()
        assert.ok(upload.height >= 40)
        if (screenshotDir && [1440, 390].includes(width))
          await page.screenshot({
            path: path.join(screenshotDir, `home-${width}.png`),
            fullPage: true,
          })
      }
      await page.locator(".drive-heading-mkdir").click()
      await page.getByRole("dialog").waitFor()
      await page.keyboard.press("Escape")
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: "dark" })
      await page.reload()
      await page.locator(".drive-file-row").first().waitFor()
      assert.equal(
        await page.locator(".drive-shell").getAttribute("data-drive-mode"),
        "dark",
      )
      if (screenshotDir)
        await page.screenshot({
          path: path.join(screenshotDir, "home-dark.png"),
          fullPage: true,
        })
      assert.deepEqual(errors, [])
    } finally {
      await browser?.close()
      await new Promise((resolve) => fixture.server.close(resolve))
    }
  },
)
