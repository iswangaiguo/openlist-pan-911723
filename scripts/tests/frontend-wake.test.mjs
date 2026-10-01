import assert from "node:assert/strict"
import { test } from "node:test"
import { build } from "esbuild"
const root = process.env.FRONTEND_TEST_REPO
if (!root) throw new Error("Set FRONTEND_TEST_REPO")
async function load(file) {
  const bundle = await build({
    entryPoints: [`${root}/src/${file}`],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["browser"],
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  )
}
const reads = await load("utils/read_deadline.ts")
const { installVideoWakeRecovery } = await load(
  "pages/home/previews/video_wake.ts",
)
function environment(t) {
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    now: Date.now,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  let now = 1700000000000,
    id = 0
  const timers = new Map()
  const window = new EventTarget(),
    document = new EventTarget()
  document.hidden = false
  window.setTimeout = (fn, delay) => {
    const key = ++id
    timers.set(key, { fn, at: now + delay })
    return key
  }
  window.clearTimeout = (key) => timers.delete(key)
  Object.assign(globalThis, {
    window,
    document,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
  })
  Date.now = () => now
  t.after(() => {
    Object.assign(globalThis, {
      window: original.window,
      document: original.document,
      setTimeout: original.setTimeout,
      clearTimeout: original.clearTimeout,
    })
    Date.now = original.now
  })
  return {
    window,
    document,
    timers,
    jump: (ms) => (now += ms),
    advance(ms) {
      const end = now + ms
      while (true) {
        const due = [...timers.entries()]
          .filter(([, v]) => v.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].fn()
      }
      now = end
    },
  }
}
test("metadata deadline aborts a hung request and preserves caller cancellation", (t) => {
  const e = environment(t),
    previous = new AbortController()
  const config = {
    url: "/fs/get",
    method: "post",
    timeout: 0,
    signal: previous.signal,
  }
  reads.boundReadRequest(config)
  assert.equal(config.timeout, 30000)
  e.advance(30000)
  assert.equal(config.signal.aborted, true)
  assert.equal(reads.didReadExpire(config), true)
  assert.equal(e.timers.size, 0)
  const second = { url: "/me", method: "get", signal: previous.signal }
  reads.boundReadRequest(second)
  previous.abort()
  assert.equal(second.signal.aborted, true)
  assert.equal(reads.didReadExpire(second), false)
  assert.equal(e.timers.size, 0)
})
test("resume uses elapsed wall time, and completed reads leave no active deadline", (t) => {
  const e = environment(t),
    config = { url: "/public/settings", method: "get" }
  reads.boundReadRequest(config)
  e.jump(120000)
  e.document.dispatchEvent(new Event("resume"))
  assert.equal(config.signal.aborted, true)
  assert.equal(reads.didReadExpire(config), true)
  const done = { url: "/fs/list?refresh=true", method: "post" }
  reads.boundReadRequest(done)
  reads.finishReadRequest(done)
  e.advance(60000)
  assert.equal(done.signal.aborted, false)
  assert.equal(e.timers.size, 0)
})
test("uploads, downloads and file mutations retain their original request policy", (t) => {
  const e = environment(t)
  for (const [method, url] of [
    ["post", "/fs/rename"],
    ["put", "/fs/put"],
    ["post", "/fs/form"],
    ["post", "/auth/login"],
    ["get", "/p/movie.mp4"],
    ["post", "/fs/other"],
  ]) {
    const config = { method, url, timeout: 0 }
    assert.equal(reads.boundReadRequest(config), config)
    assert.equal(config.signal, undefined)
    assert.equal(config.timeout, 0)
  }
  assert.equal(e.timers.size, 0)
})
test("ordinary buffering, seeking and focus do not refresh a native video", (t) => {
  const e = environment(t),
    video = { currentTime: 720, paused: false, seeking: true, ended: false },
    calls = []
  const stop = installVideoWakeRecovery(video, (resume) => calls.push(resume))
  for (let i = 0; i < 60; i++) {
    e.window.dispatchEvent(new Event("focus"))
    e.advance(1000)
  }
  assert.deepEqual(calls, [])
  stop()
  assert.equal(e.timers.size, 0)
})
test("frozen playback with no error recovers once, while healthy resumed playback is preserved", (t) => {
  const e = environment(t),
    video = { currentTime: 720, paused: false, seeking: true, ended: false },
    calls = []
  const stop = installVideoWakeRecovery(video, (resume) => calls.push(resume))
  e.document.dispatchEvent(new Event("freeze"))
  e.document.dispatchEvent(new Event("resume"))
  e.advance(14000)
  assert.deepEqual(calls, [])
  e.advance(3000)
  assert.deepEqual(calls, [true])
  e.advance(30000)
  assert.deepEqual(calls, [true])
  video.seeking = false
  e.document.dispatchEvent(new Event("freeze"))
  e.document.dispatchEvent(new Event("resume"))
  video.currentTime += 1
  e.advance(20000)
  assert.deepEqual(calls, [true])
  stop()
})
test("manual pause is preserved; a paused seek after resume can reconnect without autoplay", (t) => {
  const e = environment(t),
    video = { currentTime: 720, paused: true, seeking: false, ended: false },
    calls = []
  const stop = installVideoWakeRecovery(video, (resume) => calls.push(resume))
  e.jump(120000)
  e.window.dispatchEvent(new Event("focus"))
  e.advance(20000)
  assert.deepEqual(calls, [])
  video.seeking = true
  e.advance(17000)
  assert.deepEqual(calls, [false])
  stop()
  e.document.dispatchEvent(new Event("resume"))
  e.advance(60000)
  assert.deepEqual(calls, [false])
})
