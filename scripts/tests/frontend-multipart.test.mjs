import assert from "node:assert/strict"
import { test } from "node:test"
import { build } from "esbuild"
import { readFileSync } from "node:fs"
import path from "node:path"
const root = process.env.FRONTEND_TEST_REPO
if (!root)
  throw new Error("Set FRONTEND_TEST_REPO to the patched frontend source")
let moduleSerial = 0
async function load(relative, adapter, preamble = "") {
  const result = await build({
    stdin: {
      contents:
        preamble +
        readFileSync(path.join(root, relative), "utf8") +
        '\nexport {h} from "test:adapter";',
      resolveDir: root,
      loader: "ts",
    },
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
                /^(test:adapter|\.\/directory_snapshot|axios|\.|~\/store|~\/utils|\.\/util|\.\/stream)$/,
            },
            () => ({ path: "adapter", namespace: "test" }),
          )
          b.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents: adapter,
            loader: "ts",
          }))
        },
      },
    ],
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n// isolated-test-${++moduleSerial}`).toString("base64")}`
  )
}
test("request interceptor preserves JSON/HTML 1102 but leaves transient 503 retryable", async () => {
  const { h } = await load(
    "src/utils/request.ts",
    `
    export const h={};
    const instance={interceptors:{request:{use(){}},response:{use(ok,bad){h.bad=bad}}},defaults:{headers:{common:{}}}};
    export default {create:()=>instance,isCancel:()=>false};export const api='',log=()=>{},invalidateDirectories=()=>{},isDirectoryMutation=()=>false;
  `,
    "const localStorage={getItem:()=>'',setItem:()=>{}};const window={addEventListener:()=>{},dispatchEvent:()=>{}};\n",
  )
  for (const data of [
    { error_code: 1102 },
    "<h1>Error 1102</h1> Worker exceeded resource limits",
  ]) {
    const result = h.bad({
      response: { status: 503, data },
      message: "HTTP 503",
    })
    assert.equal(result.workerResourceLimit, true)
  }
  assert.equal(
    h.bad({
      response: { status: 503, data: "Service unavailable" },
      message: "HTTP 503",
    }).workerResourceLimit,
    undefined,
  )
})
async function uploader(resourceLimit) {
  return load(
    "src/pages/home/uploads/multipart.ts",
    `
    export const h={puts:0,posts:0,updates:[],resourceLimit:${resourceLimit},failed:false};
    export const password=()=>'',getSettingNumber=()=>10;
    export const calculateHash=()=>{throw new Error('hash not requested')},StreamUpload=()=>{throw new Error('fallback not expected')};
    const data={upload_id:'session',state:'receiving',chunk_size:10485760,total_chunks:2,received:[],received_bytes:0};
    export const r={
      post:async(url)=>{h.posts++;return {code:200,data}},
      get:async()=>({code:200,data}),
      put:async(url,body,options)=>{
        h.puts++;
        if(!h.failed){h.failed=true;return {code:503,workerResourceLimit:h.resourceLimit||undefined};}
        if(h.resourceLimit) return new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve({code:-1,message:'canceled'}),{once:true}));
        return {code:200,data};
      }
    };
  `,
    "const setTimeout=(fn)=>{fn();return 0};\n",
  )
}
test("1102 stops all chunk workers, clears speed, and never requests completion", async () => {
  const { h, MultipartUpload } = await uploader(true)
  await assert.rejects(
    MultipartUpload(
      "/B2/video",
      { size: 20971520, slice: () => new Blob(["part"]) },
      (key, value) => h.updates.push([key, value]),
    ),
    /1102/,
  )
  assert.equal(h.posts, 1)
  assert.equal(h.puts, 2)
  assert.ok(h.updates.some(([key, value]) => key === "speed" && value === 0))
})
test("transient 503 still probes and retries the part to completion", async () => {
  const { h, MultipartUpload } = await uploader(false)
  await MultipartUpload(
    "/B2/video",
    { size: 20971520, slice: () => new Blob(["part"]) },
    () => {},
  )
  assert.equal(h.puts, 3)
  assert.equal(h.posts, 2)
})

test("cancelling a multipart completion stops status polling and preserves the captured password", async () => {
  const { h, MultipartUpload } = await load("src/pages/home/uploads/multipart.ts", `
    export const h={gets:0,initPassword:'',completing:false};
    export const password=()=> 'different-directory',getSettingNumber=()=>10;
    export const calculateHash=()=>{},StreamUpload=()=>{};
    const data={upload_id:'session',state:'receiving',chunk_size:10485760,total_chunks:2,received:[],received_bytes:0};
    export const r={
      post:async(url,body,options)=>{
        if(url.endsWith('/init')){h.initPassword=options.headers.Password;return {code:200,data};}
        h.completing=true;
        return new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve({code:-1,message:'cancelled'}),{once:true}));
      },
      put:async()=>({code:200,data}),
      get:async()=>{h.gets++;return {code:200,data};}
    };
  `)
  const controller = new AbortController()
  const result = MultipartUpload('/B2/original/video', {size:20971520,type:'video/mp4',lastModified:1,slice:()=>new Blob(['part'])}, ()=>{}, false,false,false,
    {password:'original-directory',signal:controller.signal})
  while(!h.completing) await new Promise(resolve=>setImmediate(resolve))
  controller.abort()
  await assert.rejects(result, /abort/i)
  assert.equal(h.initPassword, 'original-directory')
  assert.equal(h.gets, 0)
})

const MiB = 1024 * 1024
const zeroDigest = Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(MiB))).toString('hex')
const resumeFile = (changedPart = -1) => {
  const bytes = new Uint8Array(2 * MiB)
  if(changedPart >= 0) bytes[changedPart * MiB] = 1
  return new File([bytes], 'original.mp4', {type:'video/mp4',lastModified:123456})
}
async function recoveryUploader({received=[[0,0]],sameToken=true,expired=false,completed=false}={}) {
  return load('src/pages/home/uploads/multipart.ts', `
    export const h={puts:[],posts:0,gets:0,ledger:{},checkpoints:[],updates:[]};
    export const password=()=>'',getSettingNumber=()=>1;
    export const calculateHash=()=>{throw new Error('whole-file hash must not run')},StreamUpload=()=>{throw new Error('unexpected fallback')};
    const data={upload_id:'mp_new-session',state:'receiving',chunk_size:1048576,total_chunks:2,received:${JSON.stringify(received)},received_bytes:${received.length ? MiB : 0}};
    export const r={
      post:async(url,body,options)=>{h.posts++;return {code:200,data:{...data,resume_token:${sameToken ? 'options.headers["X-Upload-Token"]' : 'undefined'}}}},
      get:async()=>{h.gets++;return ${expired ? '{code:404,data:null}' : completed ? '{code:200,data:{...data,state:"completed"}}' : '{code:200,data}'}},
      put:async(url,body,options)=>{
        const index=options.headers['X-Chunk-Index'];
        if(!h.ledger[index]) throw new Error('part must be checkpointed before sending');
        h.puts.push(index);return {code:200,data};
      }
    };
  `,'const setTimeout=(fn)=>{fn();return 0};\n')
}
function recoveryContext(h, parts = {0:zeroDigest}, uploadId='mp_new-session') {
  const resume={token:'recovery-token-11111111',uploadId,chunkSize:MiB,parts:{...parts}}
  return {resume, signal:new AbortController().signal, checkpoint:update=>{
    h.checkpoints.push(update)
    if(update.part){h.ledger[update.part.index]=update.part.digest;resume.parts[update.part.index]=update.part.digest}
    if(update.uploadId)resume.uploadId=update.uploadId
    if(update.chunkSize)resume.chunkSize=update.chunkSize
  }}
}

test('verified recovery skips only confirmed parts and persists a new digest before its request',async()=>{
  const {h,MultipartUpload}=await recoveryUploader()
  const context=recoveryContext(h)
  await MultipartUpload('/B2/original.mp4',resumeFile(),(key,value)=>h.updates.push([key,value]),false,false,false,context)
  assert.deepEqual(h.puts,[1])
  assert.equal(h.ledger[1],zeroDigest)
  assert.ok(h.updates.some(([key,value])=>key==='status'&&value==='verifying'))
  assert.ok(h.checkpoints.some(update=>update.confirmedBytes===2*MiB))
})

test('a same-name same-size modified file is rejected before sending missing parts',async()=>{
  const {h,MultipartUpload}=await recoveryUploader()
  await assert.rejects(MultipartUpload('/B2/original.mp4',resumeFile(0),()=>{},false,false,false,recoveryContext(h)),/File content changed/)
  assert.deepEqual(h.puts,[])
})

test('recovery also verifies sent-but-unacknowledged parts so an interrupted request cannot mix file versions',async()=>{
  const {h,MultipartUpload}=await recoveryUploader()
  await assert.rejects(MultipartUpload('/B2/original.mp4',resumeFile(1),()=>{},false,false,false,recoveryContext(h,{0:zeroDigest,1:zeroDigest})),/File content changed/)
  assert.deepEqual(h.puts,[])
})

test('a confirmed part without a local digest fails closed instead of trusting filename and size',async()=>{
  const {h,MultipartUpload}=await recoveryUploader()
  await assert.rejects(MultipartUpload('/B2/original.mp4',resumeFile(),()=>{},false,false,false,recoveryContext(h,{})),/ledger incomplete/)
  assert.deepEqual(h.puts,[])
})

test('an expired server session restarts all parts and resets the old ledger',async()=>{
  const {h,MultipartUpload}=await recoveryUploader({received:[],expired:true})
  const context=recoveryContext(h,{0:'f'.repeat(64)},'mp_expired-session')
  await MultipartUpload('/B2/original.mp4',resumeFile(),(key,value)=>h.updates.push([key,value]),false,false,false,context)
  assert.deepEqual(h.puts.sort(),[0,1])
  assert.ok(h.updates.some(([key,value])=>key==='notice'&&value.includes('expired')))
  assert.equal(context.resume.parts[0],zeroDigest)
})

test('a completion that finished after page close is discovered before creating a duplicate upload',async()=>{
  const {h,MultipartUpload}=await recoveryUploader({completed:true})
  await MultipartUpload('/B2/original.mp4',resumeFile(),()=>{},false,false,false,recoveryContext(h))
  assert.equal(h.posts,0);assert.equal(h.gets,1);assert.deepEqual(h.puts,[])
})

test('recovery refuses a server that does not bind the client task token',async()=>{
  const {h,MultipartUpload}=await recoveryUploader({sameToken:false})
  await assert.rejects(MultipartUpload('/B2/original.mp4',resumeFile(),()=>{},false,false,false,recoveryContext(h)),/verified recovery/)
  assert.deepEqual(h.puts,[])
})
