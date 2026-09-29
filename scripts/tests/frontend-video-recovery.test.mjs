import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { test } from "node:test"
import ts from "typescript"

const root = process.env.FRONTEND_TEST_REPO
if (!root) throw new Error("Set FRONTEND_TEST_REPO")

// Execute the actual event-binding statements from each patched player.
// Network recovery is replaced by a spy; the event handlers themselves are not mocked.
function harness(filename) {
  const source = readFileSync(
    path.join(root, "src/pages/home/previews", filename),
    "utf8",
  )
  const ast = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  let bindings
  const fatalBindings = []
  function visit(node) {
    if (ts.isBlock(node)) {
      const statements = [...node.statements]
      const start = statements.findIndex((s) =>
        s.getText(ast).startsWith('player.on("video:timeupdate"'),
      )
      const end = statements.findIndex((s) =>
        s.getText(ast).startsWith('player.on("error"'),
      )
      if (start >= 0 && end > start)
        bindings = statements
          .slice(start, end + 1)
          .map((s) => s.getText(ast))
          .join("\n")
    }
    if (
      ts.isExpressionStatement(node) &&
      /^(hlsPlayer|flvPlayer)\.on\((Hls|mpegts)\.Events\.ERROR/.test(
        node.getText(ast),
      )
    )
      fatalBindings.push(node.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(bindings, "player recovery event bindings must be exercised")
  const events = new Map(),
    documentEvents = new Map(),
    windowEvents = new Map(),
    clicks = new Map()
  const cleanups = []
  const target = (map) => ({
    addEventListener: (key, fn) => map.set(key, fn),
    removeEventListener: (key) => map.delete(key),
  })
  let refreshes = 0
  const recover = () => {
    refreshes++
  }
  const player = {
    currentTime: 720,
    playing: true,
    video: { error: null, crossOrigin: null },
    template: { $container: target(clicks) },
    on: (key, fn) => events.set(key, fn),
  }
  const hls = new Map(),
    flv = new Map()
  const context = vm.createContext({
    player,
    document: { ...target(documentEvents), hidden: false },
    window: target(windowEvents),
    Date: { now: () => 11 * 60 * 1000 },
    sourceUpdatedAt: 0,
    lastPosition: 0,
    recoveryAttempts: 0,
    refreshAttempts: 0,
    lastRecoveryAttempt: 0,
    lastRefreshAttempt: 0,
    refreshSource: recover,
    resetPlayUrl: recover,
    onCleanup: (fn) => cleanups.push(fn),
    cleanupPlayerEvents: undefined,
    hlsPlayer: { on: (key, fn) => hls.set(key, fn) },
    flvPlayer: { on: (key, fn) => flv.set(key, fn) },
    Hls: { Events: { ERROR: "error" } },
    mpegts: { Events: { ERROR: "error" } },
    console,
  })
  vm.runInContext(
    ts.transpile(bindings + "\n" + fatalBindings.join("\n"), {
      target: ts.ScriptTarget.ES2022,
    }),
    context,
  )
  return {
    player,
    context,
    events,
    hls,
    flv,
    clicks,
    documentEvents,
    windowEvents,
    refreshes: () => refreshes,
    cleanup: () => {
      cleanups.forEach((fn) => fn())
      context.cleanupPlayerEvents?.()
    },
  }
}

for (const filename of ["video.tsx", "aliyun_video.tsx"]) {
  test(`${filename}: after 10 minutes a two-minute seek, brief buffering, play and focus preserve the source`, () => {
    const h = harness(filename)
    h.events.get("video:timeupdate")?.()
    h.player.currentTime += 120
    h.events.get("video:seeking")?.()
    h.events.get("video:waiting")?.()
    h.events.get("video:play")?.()
    h.documentEvents.get("visibilitychange")?.()
    h.windowEvents.get("focus")?.()
    h.events.get("video:timeupdate")?.()
    assert.equal(h.refreshes(), 0)
    assert.equal(h.context.lastPosition, 840)
  })
  test(`${filename}: real playback errors and explicit retry still recover`, () => {
    const h = harness(filename)
    h.events.get("error")()
    assert.equal(h.refreshes(), 1)
    const click = {
      target: { closest: () => true },
      preventDefault() {},
      stopPropagation() {},
    }
    h.clicks.get("click")(click)
    assert.equal(h.refreshes(), 1, "ordinary clicks must not reload")
    h.player.video.error = { code: 2 }
    h.clicks.get("click")(click)
    assert.equal(h.refreshes(), 2)
    h.cleanup()
    assert.equal(h.clicks.size, 0)
  })
  test(`${filename}: fatal streaming errors recover, nonfatal HLS errors do not`, () => {
    const h = harness(filename)
    h.hls.get("error")(null, { fatal: false })
    assert.equal(h.refreshes(), 0)
    h.hls.get("error")(null, { fatal: true })
    assert.equal(h.refreshes(), 1)
    if (filename === "video.tsx") {
      h.flv.get("error")()
      assert.equal(h.refreshes(), 2)
    }
  })
}
