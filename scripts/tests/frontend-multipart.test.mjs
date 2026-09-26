import assert from "node:assert/strict"
import { test } from "node:test"
import { build } from "esbuild"
import { readFileSync } from "node:fs"
import path from "node:path"
const root = process.env.FRONTEND_TEST_REPO
if (!root)
  throw new Error("Set FRONTEND_TEST_REPO to the patched frontend source")
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
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
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
