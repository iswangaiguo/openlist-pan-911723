import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { test } from "node:test"
import ts from "typescript"

const root = process.env.FRONTEND_TEST_REPO
if (!root) throw new Error("Set FRONTEND_TEST_REPO")

// Execute the shipped component's request and mutation logic with controlled
// transport. In particular, older list responses must not undo newer edits.
function harness(role = 2) {
  const source = readFileSync(
    path.join(root, "src/pages/home/shares/Shares.tsx"),
    "utf8",
  )
  const ast = ts.createSourceFile(
    "Shares.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  let setup
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "Shares") {
      const body = node.initializer.body.statements
      const end = body.findIndex((statement) => ts.isReturnStatement(statement))
      setup = body
        .slice(0, end)
        .map((statement) => statement.getText(ast))
        .join("\n")
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(setup)
  const cleanups = [],
    gets = [],
    posts = []
  let getTransport = async () => ({ code: 200, data: { content: [] } })
  let postTransport = async () => ({ code: 200, data: null })
  const context = vm.createContext({
    createSignal: (initial) => {
      let value = initial
      return [
        () => value,
        (next) => {
          value = typeof next === "function" ? next(value) : next
        },
      ]
    },
    createMemo: (fn) => fn,
    useRouter: () => ({ to() {} }),
    useUtil: () => ({ copy() {} }),
    useTitle() {},
    useColorModeValue: () => () => "light",
    onMount() {},
    onCleanup: (fn) => cleanups.push(fn),
    me: () => ({ role }),
    UserMethods: { is_admin: (user) => user.role === 2 },
    shareText: (key) => key,
    shareStatus: (share) => (share.disabled ? "disabled" : "active"),
    shareUrl: (id) => id,
    notify: { success() {} },
    AbortController,
    Error,
    Date,
    setInterval,
    clearInterval,
    r: {
      get: (...args) => {
        gets.push(args)
        return getTransport(...args)
      },
      post: (...args) => {
        posts.push(args)
        return postTransport(...args)
      },
    },
  })
  vm.runInContext(
    ts.transpile(
      setup +
        "\nglobalThis.api = {refresh, perform, shares, setShares, loading, error, actionError};",
      { target: ts.ScriptTarget.ES2022 },
    ),
    context,
  )
  return {
    ...context.api,
    gets,
    posts,
    get: (fn) => {
      getTransport = fn
    },
    post: (fn) => {
      postTransport = fn
    },
    cleanup: () => cleanups.forEach((fn) => fn()),
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  }
}

const share = { id: "demo", files: ["/Documents/demo.pdf"], disabled: false }

test("newer refresh wins even when an aborted older transport still resolves", async () => {
  const h = harness(),
    pending = []
  h.get(() => new Promise((resolve) => pending.push(resolve)))
  const older = h.refresh(),
    newer = h.refresh()
  assert.equal(h.gets[0][1].signal.aborted, true)
  pending[1]({ code: 200, data: { content: [{ ...share, remark: "newer" }] } })
  await newer
  pending[0]({ code: 200, data: { content: [{ ...share, remark: "older" }] } })
  await older
  assert.equal(h.shares()[0].remark, "newer")
  assert.equal(h.loading(), false)
  h.cleanup()
})

test("an in-flight pre-delete list cannot resurrect a deleted link", async () => {
  const h = harness(),
    pending = []
  h.setShares([share])
  h.get(() => new Promise((resolve) => pending.push(resolve)))
  const before = h.refresh()
  await h.perform(share, "delete")
  assert.equal(h.shares().length, 0)
  assert.equal(h.gets[0][1].signal.aborted, true)
  pending[0]({ code: 200, data: { content: [share] } })
  await before
  assert.equal(h.shares().length, 0)
  pending[1]({ code: 200, data: { content: [] } })
  await h.flush()
  assert.equal(h.shares().length, 0)
  h.cleanup()
})

test("mutation errors preserve the link and expose a retryable error", async () => {
  const h = harness()
  h.setShares([share])
  h.post(async () => ({ code: 500, message: "storage unavailable" }))
  await h.perform(share, "delete")
  assert.equal(h.shares()[0].id, share.id)
  assert.equal(h.actionError(), "storage unavailable")
  assert.equal(h.gets.length, 0)
  h.cleanup()
})

test("failed refresh retains already loaded links instead of showing an empty list", async () => {
  const h = harness()
  h.setShares([share])
  h.get(async () => {
    throw new Error("offline")
  })
  await h.refresh()
  assert.equal(h.shares()[0].id, share.id)
  assert.equal(h.error(), "offline")
  assert.equal(h.loading(), false)
  h.cleanup()
})

test("leaving the page aborts the list and ignores its later completion", async () => {
  const h = harness()
  let resolve
  h.get(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const loading = h.refresh()
  h.cleanup()
  assert.equal(h.gets[0][1].signal.aborted, true)
  resolve({ code: 200, data: { content: [share] } })
  await loading
  assert.equal(h.shares().length, 0)
})

test("guests and general users do not fetch the administrator share list", async () => {
  for (const role of [0, 1]) {
    const h = harness(role)
    await h.refresh()
    assert.equal(h.gets.length, 0)
    h.cleanup()
  }
})
