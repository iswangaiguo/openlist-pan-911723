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

const recoveryBuild = await build({ entryPoints: [path.join(root, "src/pages/home/uploads/recovery.ts")], bundle: true, write: false, format: "esm", platform: "node" })
const { BrowserUploadPersistence } = await import(`data:text/javascript;base64,${Buffer.from(recoveryBuild.outputFiles[0].text).toString("base64")}`)
const memoryStorage = () => {
  const items = new Map()
  return { get length() { return items.size }, key: i => [...items.keys()][i] ?? null,
    getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key), items }
}
const originalFile = () => new File(['original file contents'], 'original.txt', {lastModified:123456})

test("reload restores metadata without File handles, passwords or automatic requests, and reattaches to the original destination", async () => {
  const storage = memoryStorage(), persistent = new BrowserUploadPersistence(storage, ':owner-1')
  let rows, firstContext, abort
  const first = new UploadQueue(tasks => rows = tasks, () => {})
  first.restore(persistent, () => undefined)
  first.add([originalFile()], target(async (...args) => {
    firstContext = args[6]
    firstContext.checkpoint({ uploadId:'mp_original-session', chunkSize:10, supported:true, confirmedBytes:10,
      part:{index:0,digest:'a'.repeat(64)} })
    await new Promise((resolve, reject) => { abort = () => reject(new Error('paused')); args[6].signal.addEventListener('abort',abort,{once:true}) })
  }))
  first.pause(rows[0].id); await tick()
  const raw = [...storage.items.values()].join('')
  assert.ok(!raw.includes('original-password'))
  assert.ok(!raw.includes('original file contents'))
  assert.equal(persistent.load()[0].confirmedBytes, 10)
  assert.equal(new BrowserUploadPersistence(storage, ':owner-2').load().length, 0)
  first.reset(); await tick()
  let restoredRows, calls = 0, captured
  const restored = new UploadQueue(tasks => restoredRows = tasks, () => {})
  restored.restore(new BrowserUploadPersistence(storage, ':owner-1'), () => async (...args) => { calls++; captured=args })
  await tick(); assert.equal(calls, 0); assert.equal(restoredRows[0].status, 'needs_file')
  assert.equal(restoredRows[0].requiresPassword, true)
  assert.equal(restored.attach(restoredRows[0].id, new File(['wrong'], 'original.txt',{lastModified:123456})), false)
  assert.equal(calls, 0)
  assert.equal(restored.attach(restoredRows[0].id, originalFile(), 're-entered-password'), true)
  await tick()
  assert.equal(captured[0], '/B2/original/original.txt')
  assert.equal(captured[6].password, 're-entered-password')
  assert.equal(captured[6].resume.uploadId, 'mp_original-session')
  assert.equal(captured[6].resume.parts[0], 'a'.repeat(64))
  assert.equal(restoredRows[0].status, 'success')
  assert.equal(persistent.load().length, 0)
})

test("pause followed immediately by resume waits for the aborted transport and preserves the File", async () => {
  let rows, attempts=0, running=0, max=0
  const q = new UploadQueue(tasks => rows = tasks, () => {},1)
  q.add([originalFile()], target(async (...args) => {
    running++; max=Math.max(max,running)
    const attempt=++attempts
    try { if(attempt===1) await new Promise((resolve,reject)=>args[6].signal.addEventListener('abort',()=>reject(new Error('paused')),{once:true})) }
    finally { running-- }
  }))
  q.pause(rows[0].id); q.resume(rows[0].id); await tick()
  assert.equal(attempts, 2); assert.equal(max, 1); assert.equal(rows[0].status, 'success')
})

test("offline waits, online resumes queued files, and manual pause stays paused", async () => {
  let rows, calls=0
  const q = new UploadQueue(tasks => rows = tasks, () => {})
  q.setOnline(false)
  q.add([file('auto.txt'), file('manual.txt')], target(async()=>{calls++}))
  assert.equal(calls,0);assert.ok(rows.every(row=>row.status==='waiting_network'))
  q.pause(rows[1].id);q.setOnline(true);await tick()
  assert.equal(calls,1);assert.deepEqual(rows.map(row=>row.status),['success','paused'])
  q.resume(rows[1].id);await tick();assert.equal(calls,2)
})

test("mid-upload offline aborts the connection without losing the original resume token or File", async () => {
  let rows, token, attempts=0
  const q = new UploadQueue(tasks => rows = tasks, () => {})
  q.add([originalFile()], target(async (...args)=>{
    if(++attempts===1) {
      token=args[6].resume.token
      args[6].checkpoint({confirmedBytes:10})
      await new Promise((resolve,reject)=>args[6].signal.addEventListener('abort',()=>reject(new Error('offline')),{once:true}))
    } else assert.equal(args[6].resume.token,token)
  }))
  q.setOnline(false);await tick()
  assert.equal(rows[0].status,'waiting_network');assert.equal(rows[0].speed,0)
  q.setOnline(true);await tick();assert.equal(attempts,2);assert.equal(rows[0].status,'success')
})

test("restoring an already completed server upload clears its record without asking for its File", async () => {
  const storage=memoryStorage(), persistent=new BrowserUploadPersistence(storage,'owner')
  let rows
  const first=new UploadQueue(tasks=>rows=tasks,()=>{})
  first.restore(persistent,()=>undefined)
  first.add([originalFile()],target(async (...args)=>{
    args[6].checkpoint({uploadId:'mp_complete-session',chunkSize:10,supported:true})
    await new Promise((resolve,reject)=>args[6].signal.addEventListener('abort',()=>reject(new Error('closed')),{once:true}))
  }))
  first.reset();await tick()
  let callbacks=0
  const next=new UploadQueue(tasks=>rows=tasks,()=>callbacks++,3,{probe:async()=> 'completed'})
  next.restore(persistent,()=>()=>assert.fail('completed upload must not resend'))
  await tick();assert.equal(rows[0].status,'success');assert.equal(callbacks,1);assert.equal(persistent.load().length,0)
})

test("cancelling a saved task removes recovery metadata and requests provider cleanup", async () => {
  const storage=memoryStorage(),persistent=new BrowserUploadPersistence(storage,'owner')
  let rows;const discarded=[]
  const q=new UploadQueue(tasks=>rows=tasks,()=>{},3,{discard:async id=>discarded.push(id)})
  q.restore(persistent,()=>undefined)
  q.add([originalFile()],target(async (...args)=>{
    args[6].checkpoint({uploadId:'mp_cancel-session',chunkSize:10,supported:true})
    await new Promise((resolve,reject)=>args[6].signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))
  }))
  q.cancel(rows[0].id);await tick()
  assert.equal(rows[0].status,'cancelled');assert.equal(persistent.load().length,0)
  assert.deepEqual(discarded,['mp_cancel-session'])
})

test("storage failure warns but keeps page-session upload usable", async () => {
  let rows,warnings=0,called=0
  const storage=memoryStorage();storage.setItem=()=>{throw new Error('quota exceeded')}
  const q=new UploadQueue(tasks=>rows=tasks,()=>{},3,{warning:()=>warnings++})
  q.restore(new BrowserUploadPersistence(storage,'owner'),()=>undefined)
  q.add([originalFile()],target(async()=>{called++}));await tick()
  assert.equal(called,1);assert.equal(rows[0].status,'success');assert.ok(warnings>0)
})

test("metadata reader rejects corrupt records and never accepts injected credential fields", async () => {
  const storage=memoryStorage(),persistent=new BrowserUploadPersistence(storage,'owner')
  let rows
  const q=new UploadQueue(tasks=>rows=tasks,()=>{})
  q.restore(persistent,()=>undefined);q.setOnline(false);q.add([originalFile()],target(async()=>{}))
  const record=persistent.load()[0],key=[...storage.items.keys()][0]
  storage.items.set(key,JSON.stringify({...record,password:'injected-secret',resume:{...record.resume,secret:'injected-secret'}}))
  assert.ok(!JSON.stringify(persistent.load()).includes('injected-secret'))
  storage.items.set(key,'{');assert.equal(persistent.load().length,0)
  storage.items.set(key,JSON.stringify({...record,resume:{...record.resume,parts:{'-1':'a'.repeat(64)}}}));assert.equal(persistent.load().length,0)
  storage.items.set(key,JSON.stringify({...record,size:Infinity}));assert.equal(persistent.load().length,0)
})

test("a stale tab cannot erase durable hashes written by the active tab", async () => {
  const storage=memoryStorage(),persistent=new BrowserUploadPersistence(storage,'owner')
  const q=new UploadQueue(()=>{},()=>{});q.restore(persistent,()=>undefined);q.setOnline(false)
  q.add([originalFile()],target(async()=>{}))
  const old=persistent.load()[0]
  persistent.save({...old,confirmedBytes:10,resume:{...old.resume,uploadId:'mp_same-session',chunkSize:10,parts:{0:'a'.repeat(64)}}})
  persistent.save(old)
  const actual=persistent.load()[0]
  assert.equal(actual.resume.uploadId,'mp_same-session');assert.equal(actual.resume.parts[0],'a'.repeat(64));assert.equal(actual.confirmedBytes,10)
  persistent.save({...actual,confirmedBytes:0,resume:{token:actual.token,uploadId:'mp_new-session',chunkSize:5,parts:{}}})
  assert.deepEqual(persistent.load()[0].resume.parts,{})
})

test("an exclusive task lock blocks a second tab before making upload requests", async () => {
  let rows,calls=0,locked=true
  const q=new UploadQueue(tasks=>rows=tasks,()=>{},3,{exclusive:async(token,run)=>locked?new Error('active in another tab'):run()})
  q.add([originalFile()],target(async()=>{calls++}));await tick()
  assert.equal(calls,0);assert.equal(rows[0].status,'error')
  locked=false;q.retry(rows[0].id);await tick();assert.equal(calls,1)
})
