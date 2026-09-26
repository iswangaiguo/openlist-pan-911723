import assert from "node:assert/strict"
import { test } from "node:test"
import { build } from "esbuild"
import path from "node:path"
const root = process.env.FRONTEND_TEST_REPO
if (!root) throw new Error("Set FRONTEND_TEST_REPO to the patched frontend source")
const bundled = await build({ entryPoints: [path.join(root, "src/pages/home/uploads/queue.ts")], bundle: true, write: false, format: "esm", platform: "node" })
const { UploadQueue } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
const tick = () => new Promise(resolve => setImmediate(resolve))
const file = (name = "same.txt") => ({ name, size: 100, webkitRelativePath: "" })
const target = uploader => ({ directory: "/B2/original", password: "original-password", uploader, method: "Multipart", asTask: false, overwrite: false, rapid: false })

test("queued files retain destination, method, options and password after navigation and option changes", async () => {
  let rows, release
  const calls = []
  const original = target(async (...args) => { calls.push(args); if (calls.length === 1) await new Promise(r => release = r) })
  const q = new UploadQueue(tasks => rows = tasks, () => {}, 1)
  q.add([file(), file("second.txt")], original)
  Object.assign(original, { directory: "/other", password: "changed", overwrite: true, rapid: true, method: "Form", uploader: () => { throw new Error("wrong uploader") } })
  release(); await tick()
  assert.equal(calls[1][0], "/B2/original/second.txt")
  assert.deepEqual(calls[1].slice(3, 6), [false, false, false])
  assert.equal(calls[1][6].password, "original-password")
  assert.equal(rows[1].method, "Multipart")
  assert.equal(rows[1].status, "success")
})

test("concurrency applies across multiple batches and duplicate filenames have independent IDs", async () => {
  let rows, running = 0, maximum = 0
  const release = []
  const q = new UploadQueue(tasks => rows = tasks, () => {})
  const upload = async () => { running++; maximum = Math.max(maximum, running); await new Promise(r => release.push(r)); running-- }
  q.add(Array.from({ length: 4 }, () => file()), target(upload))
  q.add([file(), file()], { ...target(upload), directory: "/B2/other" })
  assert.equal(release.length, 3)
  assert.equal(new Set(rows.map(row => row.id)).size, 6)
  assert.equal(rows[4].path, "/B2/other/same.txt")
  while (rows.some(row => row.status !== "success")) {
    release.splice(0).forEach(r => r()); await tick()
  }
  assert.equal(maximum, 3)
})

test("retry uses the original target and shares the queue limit", async () => {
  let rows, calls = 0
  const paths = []
  const q = new UploadQueue(tasks => rows = tasks, () => {}, 1)
  q.add([file()], target(async (path) => { paths.push(path); if (++calls === 1) throw new Error("temporary") }))
  await tick()
  assert.equal(rows[0].status, "error")
  q.clearDone()
  assert.equal(rows.length, 1, "failed file must retain retry handle")
  q.retry(rows[0].id); q.retry(rows[0].id)
  await tick()
  assert.equal(calls, 2)
  assert.deepEqual(paths, ["/B2/original/same.txt", "/B2/original/same.txt"])
  q.clearDone(); assert.equal(rows.length, 0)
})

test("cancel pending files prevents requests and cancelling active files ignores late progress and success", async () => {
  let rows, update, finish, completed = 0, signal
  const q = new UploadQueue(tasks => rows = tasks, () => completed++, 1)
  q.add([file(), file("queued.txt")], target(async (_path, _file, set, _task, _overwrite, _rapid, context) => {
    update = set; signal = context.signal; await new Promise(r => finish = r)
  }))
  q.cancel(rows[1].id); q.cancel(rows[0].id)
  assert.equal(signal.aborted, true)
  update("progress", 99); finish(); await tick()
  assert.equal(completed, 0)
  assert.deepEqual(rows.map(row => row.status), ["cancelled", "cancelled"])
  assert.equal(rows[0].progress, 0)
})

test("identity reset aborts active requests and discards all pending files", async () => {
  let rows, signal, finish, calls = 0
  const q = new UploadQueue(tasks => rows = tasks, () => assert.fail("cancelled task cannot complete"), 1)
  q.add([file(), file("queued.txt")], target(async (...args) => { calls++; signal = args[6].signal; await new Promise(r => finish = r) }))
  q.reset(); assert.equal(signal.aborted, true); assert.equal(rows.length, 0)
  finish(); await tick(); assert.equal(calls, 1); assert.equal(rows.length, 0)
})

test("completion identifies its own directory, including folder-upload relative paths", async () => {
  let rows; const completed = []
  const q = new UploadQueue(tasks => rows = tasks, directory => completed.push(directory))
  q.add([{ ...file(), webkitRelativePath: "folder/same.txt" }], target(async () => {}))
  await tick()
  assert.equal(rows[0].path, "/B2/original/folder/same.txt")
  assert.deepEqual(completed, ["/B2/original"])
})
