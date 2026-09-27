import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { saveDb } from "../internal/model/db"
import { fsRouter } from "./fs"
import { S3Client } from "../drivers/s3/util"

const client = () => new S3Client({ bucket: "bucket", endpoint: "https://s3.example.com", region: "us-east-1", access_key_id: "id", secret_access_key: "secret", force_path_style: true })

test("usage recursively sums a bounded page without reading bodies or signing files", async (t) => {
  let call = 0
  t.mock.method(globalThis, "fetch", async (input: any, init: RequestInit) => {
    const url = new URL(input)
    assert.equal(url.searchParams.get("prefix"), "scope/")
    assert.equal(url.searchParams.get("max-keys"), "200")
    assert.equal(url.searchParams.has("delimiter"), false)
    assert.equal(init.cache, "no-store")
    assert.equal(init.method, "GET")
    if (++call === 1) return new Response('<ListBucketResult><Contents><Key>scope/a</Key><Size>10</Size></Contents><Contents><Key>scope/sub/b&amp;c</Key><Size>25</Size></Contents><IsTruncated>true</IsTruncated></ListBucketResult>')
    assert.equal(url.searchParams.get("marker"), "scope/sub/b&c")
    return new Response('<ListBucketResult><Contents><Key>scope/z</Key><Size>7</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>')
  })
  const c = client()
  const first = await c.usagePage("scope")
  assert.equal(first.bytes, 35)
  const next = await c.usagePage("scope", first.cursor)
  assert.equal(next.bytes, 7)
  assert.equal(next.cursor, undefined)
  assert.equal(call, 2)
})

test("usage does not claim partial totals on provider or pagination failure", async (t) => {
  let xml = '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>'
  let status = 200
  t.mock.method(globalThis, "fetch", async () => new Response(xml, { status }))
  await assert.rejects(client().usagePage(""), /did not advance/)
  xml = '<ListBucketResult><Contents><Key>x</Key><Size>-1</Size></Contents></ListBucketResult>'
  await assert.rejects(client().usagePage(""), /Invalid storage/)
  status = 403
  await assert.rejects(client().usagePage(""), /403/)
})

test("storage usage rejects unauthenticated requests and scopes admin totals to mount root", async (t) => {
  const env: any = {}
  await saveDb({ settings: [{ key: "token", value: "usage-admin" }], users: [], storages: [{ id: 731, driver: "s3", mount_path: "/B2", disabled: false, addition: JSON.stringify({ bucket: "bucket", endpoint: "https://s3.example.com", region: "us-east-1", access_key_id: "id", secret_access_key: "secret", root_folder_path: "/scope", force_path_style: true }) }], metas: [], shares: [] }, env)
  const app = new Hono(); app.route("/api/fs", fsRouter)
  const denied = await app.request("/api/fs/usage?path=/B2", {}, env)
  assert.equal(denied.status, 403)
  t.mock.method(globalThis, "fetch", async (url: any) => {
    assert.equal(new URL(url).searchParams.get("prefix"), "scope/")
    return new Response('<ListBucketResult><Contents><Key>scope/file</Key><Size>128</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>')
  })
  const response = await app.request("/api/fs/usage?path=/B2/nested", { headers: { Authorization: "usage-admin" } }, env)
  const body = await response.json() as any
  assert.equal(body.code, 200)
  assert.equal(body.data.bytes, 128)
  assert.equal(body.data.mount_path, "/B2")
  const home = await app.request("/api/fs/usage", { headers: { Authorization: "usage-admin" } }, env)
  assert.equal((await home.json() as any).data.supported, false)
})
