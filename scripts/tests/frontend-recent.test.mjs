import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import vm from "node:vm"
import ts from "typescript"
import { test } from "node:test"
const root = process.env.FRONTEND_TEST_REPO
if (!root) throw new Error("Set FRONTEND_TEST_REPO")
function harness(role = 2) {
  const source = readFileSync(
    path.join(root, "src/pages/home/recent/Recent.tsx"),
    "utf8",
  )
  const ast = ts.createSourceFile(
    "Recent.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  let body
  ts.forEachChild(ast, (node) => {
    if (ts.isVariableStatement(node))
      for (const d of node.declarationList.declarations)
        if (d.name.getText(ast) === "Recent") body = d.initializer.body
  })
  const ret = body.statements.find(ts.isReturnStatement)
  const setup = source.slice(body.getStart(ast) + 1, ret.getStart(ast))
  const requests = [],
    effects = [],
    cleanups = []
  let user = { id: 1, role, base_path: "/", disabled: false }
  const signal = (value) => [
    () => value,
    (v) => {
      value = typeof v === "function" ? v(value) : v
    },
  ]
  const transport = (url, data, config = {}) =>
    new Promise((resolve) => requests.push({ url, data, config, resolve }))
  const context = {
    Error,
    AbortController,
    me: () => user,
    createSignal: signal,
    createMemo: (fn) => fn,
    createEffect: (fn) => {
      effects.push(fn)
      fn()
    },
    on: (_, fn) => fn,
    onMount: () => {},
    onCleanup: (fn) => cleanups.push(fn),
    useRouter: () => ({ to: () => {} }),
    useTitle: () => {},
    useColorModeValue: (x) => () => x,
    recentText: (x) => x,
    currentLang: () => "en",
    r: { get: (u, c) => transport(u, undefined, c), post: transport },
  }
  const js = ts.transpileModule(
    `(()=>{${setup};return {refresh,mutate,files,error,busy,setConfirm,confirm}})()`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText
  const api = vm.runInNewContext(js, context)
  return {
    ...api,
    requests,
    switchUser: () => {
      user = { ...user, id: 2 }
      effects[0]()
    },
    dispose: () => cleanups.forEach((fn) => fn()),
  }
}
const file = {
  path: "/a.pdf",
  name: "a.pdf",
  size: 10,
  type: 0,
  opened_at: 100,
}
const list = (h, index, files = [file]) =>
  h.requests[index].resolve({ code: 200, data: { content: files } })
const tick = () => new Promise((resolve) => setImmediate(resolve))
test("newest refresh wins even if aborted transport resolves later", async () => {
  const h = harness()
  void h.refresh()
  list(h, 1, [{ ...file, path: "/new.pdf" }])
  await tick()
  list(h, 0)
  await tick()
  assert.equal(h.files()[0].path, "/new.pdf")
})
test("pre-removal refresh cannot restore a removed recent record", async () => {
  const h = harness()
  list(h, 0)
  await tick()
  void h.refresh()
  void h.mutate(file.path)
  h.requests[2].resolve({ code: 200 })
  await tick()
  list(h, 1)
  await tick()
  assert.equal(h.files().length, 0)
})
test("failed clear retains records and confirmation for retry", async () => {
  const h = harness()
  list(h, 0)
  await tick()
  h.setConfirm(true)
  void h.mutate()
  h.requests[1].resolve({ code: 500 })
  await tick()
  assert.equal(h.files().length, 1)
  assert.equal(h.confirm(), true)
  assert.equal(h.error(), "change_error")
})
test("failed background refresh retains current history", async () => {
  const h = harness()
  list(h, 0)
  await tick()
  void h.refresh()
  h.requests[1].resolve({ code: 500 })
  await tick()
  assert.equal(h.files().length, 1)
  assert.equal(h.error(), "load_error")
})
test("late mutation cannot modify a switched account", async () => {
  const h = harness()
  list(h, 0)
  await tick()
  void h.mutate()
  h.switchUser()
  list(h, 2, [{ ...file, path: "/other.pdf" }])
  await tick()
  h.requests[1].resolve({ code: 200 })
  await tick()
  assert.equal(h.files()[0].path, "/other.pdf")
})
test("guest access does not request account history", () => {
  assert.equal(harness(1).requests.length, 0)
})
test("navigation cleanup aborts and ignores late list results", async () => {
  const h = harness()
  h.dispose()
  assert.equal(h.requests[0].config.signal.aborted, true)
  list(h, 0)
  await tick()
  assert.equal(h.files().length, 0)
})

function recordHarness(user = { id: 1, role: 0 }) {
  const source = readFileSync(
    path.join(root, "src/pages/home/recent/record.ts"),
    "utf8",
  )
  const posts = [],
    events = [],
    markers = []
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const exports = {}
  vm.runInNewContext(js, {
    exports,
    require: (name) =>
      name === "~/store/user"
        ? { me: () => user }
        : {
            r: {
              post: async (...args) => {
                posts.push(args)
                return { code: 200 }
              },
            },
          },
    window: { dispatchEvent: (e) => events.push(e.type) },
    Event: class {
      constructor(type) {
        this.type = type
      }
    },
    localStorage: { setItem: (...args) => markers.push(args) },
    Date,
  })
  return { ...exports, posts, events, markers }
}
test("recording sends safe file metadata, excluding preview secrets", async () => {
  const h = recordHarness()
  h.recordRecent("/中文/# report?.pdf", {
    is_dir: false,
    size: 12,
    type: 0,
    raw_url: "signed-secret",
    password: "secret",
    sign: "secret",
    thumb: "private",
  })
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(h.posts[0])), [
    "/recent/record",
    { path: "/中文/# report?.pdf", size: 12, type: 0 },
    { timeout: 10000 },
  ])
  assert.deepEqual(h.events, ["openlist:recent-change"])
  assert.match(h.markers[0][1], /^1:\d+$/)
})
test("guest, disabled, directories and public-share navigation never write history", () => {
  const file = { is_dir: false, size: 12, type: 0 }
  for (const user of [
    { id: 2, role: 1 },
    { id: 0, role: 0 },
    { id: 1, role: 0, disabled: true },
  ]) {
    const h = recordHarness(user)
    h.recordRecent("/private.pdf", file)
    assert.equal(h.posts.length, 0)
  }
  const h = recordHarness()
  h.recordRecent("/folder", { ...file, is_dir: true })
  h.recordRecent("/@share/public", file)
  assert.equal(h.posts.length, 0)
})
