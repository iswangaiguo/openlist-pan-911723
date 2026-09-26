import assert from "node:assert/strict"
import { test } from "node:test"
import { build } from "esbuild"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = process.env.FRONTEND_TEST_REPO
if (!root)
  throw new Error("Set FRONTEND_TEST_REPO to the patched frontend source")

// Exercise the real navigation hook against controllable transport/store adapters.
// No live accounts, browser credentials or cloud files are used.
async function harness() {
  const adapter = `
    export const h = { path: '/a', page: 1, calls: [], user: { id: 1, role: 0, permission: 8, base_path: '/' }, state: {}, password: '' };
    export const State = { Initial:0, FetchingObj:1, FetchingObjs:2, FetchingMore:3, Folder:4, File:5, NeedPassword:6 };
    export const objStore = h.state;
    export const ObjStore = Object.fromEntries(['Objs','Total','Readme','Header','Write','WriteContentBypass','Provider','DirectUploadTools','State','Err','Revalidating','Obj','Related','RawUrl'].map(k=>['set'+k,v=>{h.state[k[0].toLowerCase()+k.slice(1)]=v}]));
    ObjStore.mergeObjs=v=>{h.merges=(h.merges||0)+1;h.state.objs=v};
    export const me=()=>h.user, password=()=>h.password, shouldKeepState=()=>false;
    export const getPagination=()=>({type:'all',size:30});
    export const getHistoryKey=p=>p, hasHistory=()=>false, recoverHistory=()=>{}, clearHistory=()=>{};
    export const appendObjs=v=>h.state.objs.push(...v);
    export const useFetch=fn=>[()=>false,fn];
    export const useRouter=()=>({pathname:()=>h.path,to:p=>{h.path=p},searchParams:{}});
    export const fsList=(p,pwd,page,size,force)=>new Promise(resolve=>h.calls.push({path:p,force,resolve}));
    export const fsGet=p=>new Promise(resolve=>h.calls.push({path:p,get:true,resolve}));
    export const handleRespWithoutNotify=(r,ok,bad)=>r.code===200?ok(r.data):bad?.(r.message,r.code);
    export const log=()=>{},notify={error:()=>{}},pathJoin=(a,b)=>a+'/'+b;
  `
  const source =
    readFileSync(path.join(root, "src/hooks/usePath.ts"), "utf8") +
    '\nexport {h} from "test:adapter";\nexport {directorySnapshots,invalidateDirectories,DirectorySnapshots,snapshotTtl,isDirectoryMutation} from "~/utils/directory_snapshot";'
  const result = await build({
    stdin: { contents: source, resolveDir: root, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [
      {
        name: "adapters",
        setup(b) {
          b.onResolve(
            {
              filter:
                /^(test:adapter|~\/store|~\/utils|\.\/useFetch|\.\/useRouter|axios)$/,
            },
            (args) => ({
              path: args.path === "axios" ? "axios" : "adapter",
              namespace: "test",
            }),
          )
          b.onResolve({ filter: /^~\/utils\/directory_snapshot$/ }, () => ({
            path: path.join(root, "src/utils/directory_snapshot.ts"),
          }))
          b.onLoad({ filter: /.*/, namespace: "test" }, (args) => ({
            contents:
              args.path === "axios"
                ? "export default {CancelToken:class {constructor(fn){fn(()=>{})}}}"
                : adapter,
            loader: "js",
          }))
        },
      },
    ],
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${Math.random()}`
  )
}
const response = (name) => ({
  code: 200,
  message: "success",
  data: {
    content: [{ name, is_dir: false, size: 1, sign: "" }],
    total: 1,
    write: true,
    header: "",
    readme: "",
    provider: "S3",
  },
})

test("revisit shows names synchronously while a fresh request is still pending", async () => {
  const { h, usePath } = await harness()
  const nav = usePath()
  nav.setPathAs("/a")
  nav.setPathAs("/b")
  let p = nav.handlePathChange("/a")
  h.calls.at(-1).resolve(response("A"))
  await p
  h.path = "/b"
  p = nav.handlePathChange("/b")
  h.calls.at(-1).resolve(response("B"))
  await p
  h.path = "/a"
  p = nav.handlePathChange("/a")
  assert.equal(h.state.state, 4)
  assert.equal(h.state.objs[0].name, "A")
  assert.equal(h.state.revalidating, true)
  assert.equal(h.calls.length, 3)
  h.calls.at(-1).resolve(response("A updated"))
  await p
  assert.equal(h.state.objs[0].name, "A updated")
  assert.equal(
    h.merges,
    1,
    "background success must reconcile, not replace, rows",
  )
  assert.equal(h.state.revalidating, false)
})
test("slow older navigation cannot overwrite a newer directory", async () => {
  const { h, usePath } = await harness()
  const nav = usePath()
  nav.setPathAs("/a")
  nav.setPathAs("/b")
  const a = nav.handlePathChange("/a")
  const old = h.calls.at(-1)
  h.path = "/b"
  const b = nav.handlePathChange("/b")
  h.calls.at(-1).resolve(response("B"))
  await b
  old.resolve(response("A"))
  await a
  assert.equal(h.state.objs[0].name, "B")
})
test("permission denial and network errors erase the displayed snapshot", async () => {
  for (const code of [401, 403, undefined]) {
    const { h, usePath } = await harness()
    const nav = usePath()
    nav.setPathAs("/a")
    let p = nav.handlePathChange("/a")
    h.calls.at(-1).resolve(response("private"))
    await p
    p = nav.handlePathChange("/a")
    assert.equal(h.state.objs.length, 1)
    h.calls.at(-1).resolve({ code, message: "denied" })
    await p
    assert.equal(h.state.objs.length, 0)
    assert.equal(h.state.revalidating, false)
    p = nav.handlePathChange("/a")
    assert.equal(h.state.state, 2)
    h.calls.at(-1).resolve(response("new"))
    await p
  }
})
test("force refresh and changed user/password bypass snapshots", async () => {
  const { h, usePath } = await harness()
  const nav = usePath()
  nav.setPathAs("/a")
  let p = nav.handlePathChange("/a")
  h.calls.at(-1).resolve(response("private"))
  await p
  p = nav.handlePathChange("/a", undefined, false, true)
  assert.equal(h.state.state, 2)
  assert.equal(h.calls.at(-1).force, true)
  h.calls.at(-1).resolve(response("fresh"))
  await p
  h.user = { ...h.user, id: 2 }
  p = nav.handlePathChange("/a")
  assert.equal(h.state.state, 2)
  h.calls.at(-1).resolve(response("other user"))
  await p
  h.password = "changed"
  p = nav.handlePathChange("/a")
  assert.equal(h.state.state, 2)
  h.calls.at(-1).resolve(response("password"))
  await p
})
test("mutation invalidation discards in-flight data and retries before display", async () => {
  const { h, usePath, invalidateDirectories } = await harness()
  const nav = usePath()
  nav.setPathAs("/a")
  const p = nav.handlePathChange("/a")
  const old = h.calls.at(-1)
  invalidateDirectories()
  old.resolve(response("deleted"))
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.calls.length, 2)
  h.calls.at(-1).resolve(response("remaining"))
  await p
  assert.equal(h.state.objs[0].name, "remaining")
})
test("bounded LRU, TTL, copy isolation and generation guard", async () => {
  const { DirectorySnapshots } = await harness()
  let now = 0
  const c = new DirectorySnapshots(() => now, 2, 1000)
  c.put("a", { name: "a" }, 0, 100)
  c.put("b", { name: "b" }, 0, 100)
  c.get("a").name = "mutated"
  c.put("c", { name: "c" }, 0, 100)
  assert.equal(c.get("b"), undefined)
  assert.equal(c.get("a").name, "a")
  now = 101
  assert.equal(c.get("a"), undefined)
  c.clear()
  c.put("stale", { name: "stale" }, 0)
  assert.equal(c.get("stale"), undefined)
  c.put("huge", { name: "x".repeat(1001) }, c.revision)
  assert.equal(c.get("huge"), undefined)
})
test("signature expiry and mutation endpoint classification", async () => {
  const { snapshotTtl, isDirectoryMutation } = await harness()
  assert.equal(snapshotTtl([{ sign: "1000.abc" }], 950000), 40000)
  assert.equal(snapshotTtl([{ sign: "abc:1000" }], 990000), 0)
  assert.equal(snapshotTtl([{ sign: "0.abc" }], 950000), 120000)
  assert.equal(snapshotTtl([{ sign: "unknown" }]), 0)
  for (const endpoint of [
    "remove",
    "put",
    "mkdir",
    "rename",
    "move",
    "copy",
    "upload/complete",
    "multipart/complete",
  ])
    assert.equal(isDirectoryMutation("post", "/fs/" + endpoint), true)
  for (const endpoint of ["list", "get", "dirs", "search"])
    assert.equal(isDirectoryMutation("post", "/fs/" + endpoint), false)
  assert.equal(isDirectoryMutation("post", "/admin/user/update"), true)
})

test("real Solid store reconciliation keeps rows/selection while renewing signatures", async () => {
  const result = await build({
    stdin: {
      contents: `
        import {createStore} from 'solid-js/store';
        import {reconcileDirectory} from './src/utils/directory_reconcile';
        export {createStore,reconcileDirectory};
      `,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["browser"],
  })
  const { createStore, reconcileDirectory } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  )
  const item = (name, sign) => ({
    name,
    is_dir: false,
    size: 12,
    modified: "2026-09-26",
    type: 2,
    sign,
  })
  const [state, set] = createStore({
    objs: [{ ...item("B", "old"), selected: true }, item("A", "old")],
  })
  const b = state.objs[0],
    a = state.objs[1]
  const stable = reconcileDirectory(state.objs, [
    item("A", "new"),
    item("B", "new"),
  ])
  assert.equal(stable.sameMembership, true)
  set("objs", stable.update)
  assert.equal(state.objs[0], b, "existing sorted row must keep its identity")
  assert.equal(state.objs[1], a)
  assert.equal(state.objs[0].selected, true)
  assert.equal(
    state.objs[0].sign,
    "new",
    "renew signatures even when visible metadata is unchanged",
  )
  const changed = reconcileDirectory(state.objs, [
    { ...item("B", "newer"), size: 50 },
    item("C", "new"),
  ])
  assert.equal(changed.sameMembership, false)
  set("objs", changed.update)
  assert.equal(
    state.objs[0],
    b,
    "surviving rows keep identity even when membership changes",
  )
  assert.equal(state.objs[0].size, 50)
  assert.equal(state.objs[0].selected, true)
  assert.deepEqual(
    state.objs.map((o) => o.name),
    ["B", "C"],
  )
})
