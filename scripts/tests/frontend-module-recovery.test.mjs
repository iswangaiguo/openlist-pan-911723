import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
const root=process.env.FRONTEND_TEST_REPO
if(!root) throw new Error('Set FRONTEND_TEST_REPO')
const bundle=await build({entryPoints:[root+'/src/utils/module_recovery.ts'],bundle:true,write:false,format:'esm',platform:'browser',conditions:['browser']})
const {isModuleLoadError,claimModuleReload,setUnfinishedUploads,unfinishedUploads}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)}}
test('browser module failure formats are recognized without swallowing API/programming errors',()=>{
  for(const message of ['TypeError: Failed to fetch dynamically imported module: /assets/File-old.js','Importing a module script failed.','error loading dynamically imported module','Unable to preload CSS for /assets/File.css','Loading chunk 13 failed.']) assert.equal(isModuleLoadError(message),true)
  for(const message of ['TypeError: Failed to fetch','TypeError: Cannot read properties of undefined','HTTP 503']) assert.equal(isModuleLoadError(message),false)
})
test('automatic recovery reloads once per tab and never loops through persistent failures',()=>{
  const s=storage(), now=1700000000000
  assert.equal(claimModuleReload(s,now),true)
  assert.equal(claimModuleReload(s,now+1),false)
  assert.equal(claimModuleReload(s,now+10000),false)
  assert.equal(claimModuleReload(s,now+900001),true)
})
test('unfinished uploads prevent reload without consuming the later recovery attempt',()=>{
  const s=storage(),now=1700000000000
  setUnfinishedUploads(1)
  assert.equal(claimModuleReload(s,now,unfinishedUploads()>0),false)
  assert.equal(s.getItem('openlist:module-reload'),null)
  setUnfinishedUploads(0)
  assert.equal(claimModuleReload(s,now,unfinishedUploads()>0),true)
})
test('denied browser storage uses explicit retry rather than risking a reload loop',()=>{
  const s={getItem:()=>{throw new Error('denied')},setItem:()=>{throw new Error('denied')}}
  assert.equal(claimModuleReload(s,1700000000000),false)
})
