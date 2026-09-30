import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { test } from "node:test"
import ts from "typescript"

const root = process.env.FRONTEND_TEST_REPO
if (!root) throw new Error("Set FRONTEND_TEST_REPO")

// Execute the actual component's loading and event logic; JSX rendering is
// outside this request-count regression. Transport and time are controllable.
function harness(
  mounts = [
    { storage_id: 1, mount_path: "/B2" },
    { storage_id: 2, mount_path: "/R2" },
  ],
) {
  const source = readFileSync(
    path.join(root, "src/pages/home/DriveUsage.tsx"),
    "utf8",
  )
  const ast = ts.createSourceFile(
    "usage.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  let setup
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === "DriveUsage"
    ) {
      const statements = [...node.initializer.body.statements]
      const end = statements.findIndex((s) =>
        s.getText(ast).startsWith("const label ="),
      )
      assert.ok(end > 0)
      setup = statements
        .slice(0, end)
        .map((s) => s.getText(ast))
        .join("\n")
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(setup)
  const events = new Map(),
    timers = new Map(),
    calls = [],
    cleanups = []
  let now = 1000000,
    nextTimer = 0,
    user = { id: 1, role: 2, base_path: "/" }
  let transport = async (mount) => ({
    code: 200,
    data: {
      supported: true,
      storage_id: mount.storage_id,
      bytes: mount.storage_id * 10,
    },
  })
  const context = vm.createContext({
    cache: new Map(),
    createSignal: (initial) => {
      let value = initial
      return [
        () => value,
        (next) => {
          value = next
        },
      ]
    },
    createEffect: () => {},
    on: () => {},
    onCleanup: (fn) => cleanups.push(fn),
    useRouter: () => ({ isShare: () => false }),
    me: () => user,
    UserMethods: { is_admin: (user) => user.role === 2 },
    currentLang: () => "zh",
    AbortController,
    Date: { now: () => now },
    window: {
      matchMedia: () => ({
        matches: true,
        addEventListener() {},
        removeEventListener() {},
      }),
      addEventListener: (name, fn) => events.set(name, fn),
      removeEventListener: (name) => events.delete(name),
    },
    setTimeout: (fn, delay) => {
      const id = ++nextTimer
      timers.set(id, { fn, at: now + delay })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    r: {
      get: async (_url, { params, signal }) => {
        calls.push(params)
        if (params.scope === "all") return { code: 200, data: { mounts } }
        return transport(
          mounts.find((m) => m.mount_path === params.path),
          params.cursor,
          signal,
        )
      },
    },
  })
  vm.runInContext(
    ts.transpile(
      setup + "\nglobalThis.api = { load, usage, status, unavailable };",
      { target: ts.ScriptTarget.ES2022 },
    ),
    context,
  )
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  return {
    ...context.api,
    calls,
    transport: (fn) => {
      transport = fn
    },
    upload: (path) => events.get("openlist:upload-complete")({ detail: path }),
    user: (next) => {
      user = next
    },
    advance: async (duration) => {
      now += duration
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id)
          await timer.fn()
        }
      await flush()
    },
    cleanup: () => cleanups.forEach((fn) => fn()),
    flush,
  }
}

test("uploads refresh only the affected mount, reuse even aged unrelated totals and coalesce directories", async () => {
  const h = harness()
  await h.load()
  assert.equal(h.usage().bytes, 30)
  h.calls.length = 0
  await h.advance(300001)
  h.transport(async (mount) => ({
    code: 200,
    data: { supported: true, storage_id: mount.storage_id, bytes: 100 },
  }))
  h.upload("/B2/videos")
  h.upload("/B2/photos")
  await h.advance(500)
  assert.deepEqual(
    h.calls.filter((p) => p.path).map((p) => p.path),
    ["/B2"],
  )
  assert.equal(h.usage().bytes, 120)
  h.cleanup()
})

test("nested mounts use the longest path match and ignore missing or lookalike paths", async () => {
  const h = harness([
    { storage_id: 1, mount_path: "/" },
    { storage_id: 2, mount_path: "/B2" },
    { storage_id: 3, mount_path: "/B2/nested" },
  ])
  await h.load()
  h.calls.length = 0
  h.upload(undefined)
  await h.advance(500)
  assert.equal(h.calls.length, 0)
  h.upload("/B2/nested/videos")
  await h.advance(500)
  assert.deepEqual(
    h.calls.filter((p) => p.path).map((p) => p.path),
    ["/B2/nested"],
  )
  h.calls.length = 0
  h.upload("/B2-other/videos")
  await h.advance(500)
  assert.deepEqual(
    h.calls.filter((p) => p.path).map((p) => p.path),
    ["/"],
  )
  h.cleanup()
})

test("explicit refresh scans all mounts and sums every metadata page", async () => {
  const h = harness()
  await h.load()
  h.calls.length = 0
  h.transport(async (mount, cursor) => ({
    code: 200,
    data: {
      supported: true,
      storage_id: mount.storage_id,
      bytes: cursor ? 5 : 7,
      cursor: cursor ? undefined : "next",
    },
  }))
  await h.load(true)
  assert.deepEqual(
    h.calls.filter((p) => p.path).map((p) => p.path),
    ["/B2", "/B2", "/R2", "/R2"],
  )
  assert.equal(h.usage().bytes, 24)
  h.cleanup()
})

test("upload during initial scan waits for its completion, then refreshes only the changed mount", async () => {
  const h = harness()
  let release
  h.transport(async (mount) => {
    if (mount.storage_id === 1)
      await new Promise((resolve) => {
        release = resolve
      })
    return {
      code: 200,
      data: { supported: true, storage_id: mount.storage_id, bytes: 10 },
    }
  })
  const initial = h.load()
  await h.flush()
  h.upload("/B2/videos")
  await h.advance(500)
  assert.equal(h.calls.filter((p) => p.path).length, 1)
  release()
  await initial
  h.calls.length = 0
  h.transport(async (mount) => ({
    code: 200,
    data: { supported: true, storage_id: mount.storage_id, bytes: 20 },
  }))
  await h.advance(500)
  assert.deepEqual(
    h.calls.filter((p) => p.path).map((p) => p.path),
    ["/B2"],
  )
  assert.equal(h.usage().bytes, 30)
  h.cleanup()
})

test("failed affected scan cannot reuse its pre-upload total, and non-root user paths resolve to the mount", async () => {
  const h = harness()
  h.user({ id: 1, role: 2, base_path: "/B2" })
  await h.load()
  h.calls.length = 0
  h.transport(async () => ({ code: 500 }))
  h.upload("/videos")
  await h.advance(500)
  assert.deepEqual(
    h.calls.filter((p) => p.path).map((p) => p.path),
    ["/B2"],
  )
  assert.equal(h.usage().bytes, 20)
  assert.equal(h.unavailable(), 1)
  h.calls.length = 0
  await h.load()
  assert.deepEqual(
    h.calls.filter((p) => p.path).map((p) => p.path),
    ["/B2"],
  )
  h.cleanup()
})
