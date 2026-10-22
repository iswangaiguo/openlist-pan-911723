import assert from "node:assert/strict"
import { test } from "node:test"
import { build } from "esbuild"
import path from "node:path"

const root = process.env.FRONTEND_TEST_REPO
if (!root)
  throw new Error("Set FRONTEND_TEST_REPO to the patched frontend source")

// Load the real B2 job poller with a scripted request adapter.
async function harness(replies) {
  const result = await build({
    entryPoints: [path.join(root, "src/utils/b2-jobs.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [
      {
        name: "request",
        setup(b) {
          b.onResolve({ filter: /^\.\/request$/ }, () => ({
            path: "request",
            namespace: "test",
          }))
          b.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents: `
              export const calls = []
              export const r = { post: async (url, body) => {
                calls.push(body.path)
                return globalThis.__b2Replies.shift()
              } }`,
            loader: "js",
          }))
        },
      },
    ],
  })
  globalThis.__b2Replies = replies
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${Math.random()}`
  )
}

const step = (data) => ({ code: 200, message: "success", data })

test("one shared poller advances a job until it is done", async () => {
  const { driveB2Job } = await harness([
    step({ state: "migrating", done: false }),
    step({ state: "verifying", done: false }),
    step({ done: true }),
  ])
  const a = driveB2Job("/B2/old")
  const b = driveB2Job("/B2/old")
  assert.equal(a, b)
  await a
  assert.equal(globalThis.__b2Replies.length, 0)
  // After finishing, a later call starts a fresh poller.
  globalThis.__b2Replies = [step({ done: true })]
  await driveB2Job("/B2/old")
})

test("a paused or failed job stops polling and reports its error", async () => {
  const { driveB2Job } = await harness([
    step({ state: "paused", error: "B2 source version changed", done: false }),
  ])
  await assert.rejects(driveB2Job("/B2/old"), (error) => {
    assert.match(error.message, /source version changed/)
    assert.equal(error.paused, true)
    return true
  })
  // Other failures (e.g. no write permission) are not pauses: callers stop.
  globalThis.__b2Replies = [{ code: 403, message: "Forbidden", data: null }]
  await assert.rejects(driveB2Job("/B2/old"), (error) => {
    assert.match(error.message, /Forbidden/)
    assert.equal(error.paused, undefined)
    return true
  })
})
