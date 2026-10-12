import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { createSearchFixture } from "./helpers/frontend-search-fixture.mjs"
const { chromium } = await import(
  process.env.PDF_TEST_PLAYWRIGHT_MODULE || "playwright"
)

test(
  "login preserves password, OTP, LDAP, alternatives and responsive layout",
  { timeout: 90000 },
  async () => {
    const fixture = createSearchFixture(
      path.resolve(process.env.FRONTEND_BROWSER_DIST || "dist"),
    )
    await new Promise((resolve) =>
      fixture.server.listen(0, "127.0.0.1", resolve),
    )
    let browser
    try {
      browser = await chromium.launch({ headless: true })
      const base = `http://127.0.0.1:${fixture.server.address().port}`
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        locale: "en-US",
      })
      const errors = [],
        requests = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.route("**/api/auth/login/hash", async (route) => {
        const body = route.request().postDataJSON()
        requests.push(body)
        await route.fulfill({
          json:
            body.otp_code === "123456"
              ? { code: 200, data: { token: "test-only-token" } }
              : { code: 402, message: "OTP required" },
        })
      })
      await page.goto(`${base}/@login?redirect=%2FDocuments`)
      await page.getByLabel("Username", { exact: true }).fill("demo")
      await page
        .getByLabel("Password", { exact: true })
        .fill("test-only-password")
      const previews = process.env.LOGIN_SCREENSHOT_DIR
      if (previews) fs.mkdirSync(previews, { recursive: true })
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 })
        assert.ok(
          await page
            .getByRole("button", { name: "Login", exact: true })
            .isVisible(),
        )
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `overflow at ${width}`,
        )
        if (previews && [1440, 390].includes(width))
          await page.screenshot({
            path: path.join(previews, `login-${width}.png`),
            fullPage: true,
          })
      }
      await page.getByLabel("Password", { exact: true }).press("Enter")
      await page.getByLabel("Verification code", { exact: true }).waitFor()
      assert.equal(requests.length, 1)
      assert.equal(requests[0].username, "demo")
      assert.notEqual(requests[0].password, "test-only-password")
      await page.getByLabel("Verification code", { exact: true }).fill("123456")
      await page.getByLabel("Verification code", { exact: true }).press("Enter")
      await page.waitForURL(`${base}/Documents`)
      assert.equal(requests.length, 2)
      assert.equal(requests[1].otp_code, "123456")
      assert.deepEqual(errors, [])

      const dark = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        locale: "en-US",
        colorScheme: "dark",
      })
      await dark.route("**/api/public/settings", async (route) => {
        const response = await route.fetch(),
          json = await response.json()
        Object.assign(json.data, {
          ldap_login_enabled: "true",
          ldap_login_tips: "Use directory account",
          sso_login_enabled: "true",
          sso_login_platform: "Github",
          webauthn_login_enabled: "true",
        })
        await route.fulfill({ json })
      })
      // Do not open an authenticator during this UI regression.
      await dark.addInitScript(() => {
        if (globalThis.PublicKeyCredential)
          PublicKeyCredential.isConditionalMediationAvailable = async () =>
            false
      })
      let ldapBody
      await dark.route("**/api/auth/login/ldap", async (route) => {
        ldapBody = route.request().postDataJSON()
        await route.fulfill({
          json: { code: 400, message: "Test login rejected" },
        })
      })
      await dark.goto(`${base}/@login?redirect=%2FDocuments`)
      await dark.getByLabel("Username", { exact: true }).fill("directory-user")
      await dark
        .getByLabel("Password", { exact: true })
        .fill("test-directory-password")
      await dark.getByRole("button", { name: "Login", exact: true }).click()
      await dark.getByText("Test login rejected", { exact: true }).waitFor()
      assert.equal(ldapBody.password, "test-directory-password")
      assert.ok(
        await dark
          .getByRole("button", { name: "Continue with Github", exact: true })
          .isVisible(),
      )
      await dark
        .getByRole("button", { name: "Use a passkey", exact: true })
        .click()
      assert.equal(
        await dark.getByLabel("Password", { exact: true }).count(),
        0,
      )
      await dark
        .getByRole("button", { name: "Use a password instead", exact: true })
        .click()
      await dark.getByRole("button", { name: "Clear", exact: true }).click()
      assert.equal(
        await dark.getByLabel("Username", { exact: true }).inputValue(),
        "",
      )
      assert.equal(
        await dark.getByLabel("Password", { exact: true }).inputValue(),
        "",
      )
      assert.equal(
        await dark.locator(".login-workspace").getAttribute("data-login-mode"),
        "dark",
      )
      if (previews)
        await dark.screenshot({
          path: path.join(previews, "login-dark.png"),
          fullPage: true,
        })
      await dark
        .getByRole("button", { name: "Browse as a guest", exact: true })
        .click()
      await dark.waitForURL(`${base}/Documents`)
    } finally {
      await browser?.close()
      await new Promise((resolve) => fixture.server.close(resolve))
    }
  },
)
