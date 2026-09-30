import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { Hono } from "hono"
import { fsRouter } from "./fs"
import { getB2RenameJob, readB2RenameJob } from "./b2_rename"
import { assertB2PathWritable } from "../internal/op/storage"
import { d1 } from "../internal/op/directory-cache.test-helper"
import { S3Driver } from "../drivers/s3/driver"
import {
  saveDb,
  __setStoreBackendLoaderForTest,
  __resetDbCacheForTest,
} from "../internal/model/db"

async function setup(t: TestContext) {
  const DB = d1()
  const env = { DB }
  const storage = {
    id: 41,
    driver: "S3",
    mount_path: "/B2",
    status: "work",
    modified: "read-cache-test",
    addition: {
      bucket: "bucket",
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      access_key_id: "test",
      secret_access_key: "test",
    },
  }
  let data: any = {
    settings: [{ key: "token", value: "read-cache-admin" }],
    users: [],
    storages: [storage],
    metas: [],
    shares: [],
  }
  __resetDbCacheForTest()
  __setStoreBackendLoaderForTest(async () => ({
    name: "test",
    isConfigured: async () => true,
    load: async () => structuredClone(data),
    save: async (next: any) => {
      data = structuredClone(next)
      return true
    },
  }))
  t.after(() => {
    __resetDbCacheForTest()
    DB.sqlite.close()
  })
  await saveDb(data, env)
  await getB2RenameJob(env, storage.id)
  DB.sqlite.exec(`INSERT INTO openlist_b2_rename_jobs
    (id, storage_id, source, target, source_virtual, target_virtual, fingerprint, state, lease_until, updated_at)
    VALUES ('job', 41, 'old', 'new', '/B2/old', '/B2/new', 'test', 'migrating', 0, 0)`)
  let queries = 0
  const prepare = DB.prepare.bind(DB)
  t.mock.method(DB, "prepare", (sql: string) => {
    if (sql === "SELECT * FROM openlist_b2_rename_jobs WHERE storage_id = ?")
      queries++
    return prepare(sql)
  })
  t.mock.method(S3Driver.prototype, "listMetadata", async () => [])
  t.mock.method(S3Driver.prototype, "get", async () => ({
    name: "movie.mp4",
    size: 10,
    is_dir: false,
    modified: "2026-09-30",
    sign: "",
    type: 2,
  }))
  const app = new Hono()
  app.route("/api/fs", fsRouter)
  const request = async (endpoint: string, path: string) => {
    const response = await app.request(
      `/api/fs/${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: "read-cache-admin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path }),
      },
      env,
    )
    const body: any = await response.json()
    assert.equal(body.code, 200)
    return body.data
  }
  return { DB, env, storage, queries: () => queries, request }
}

test("list reuses its B2 snapshot for write visibility, while the next request sees completion", async (t) => {
  const h = await setup(t)
  assert.equal((await h.request("list", "/B2/new")).write, false)
  assert.equal(h.queries(), 1)
  h.DB.sqlite.exec("DELETE FROM openlist_b2_rename_jobs")
  assert.equal((await h.request("list", "/B2/new")).write, true)
  assert.equal(h.queries(), 2)
})

test("get shares one B2 query with the write lock and related-file listing", async (t) => {
  const h = await setup(t)
  assert.equal((await h.request("get", "/B2/new/movie.mp4")).write, false)
  assert.equal(h.queries(), 1)
})

test("mutation guards bypass even a stale null read snapshot", async (t) => {
  const h = await setup(t)
  const context = {
    env: h.env,
    b2RenameJobs: new Map([[41, Promise.resolve(null)]]),
  }
  assert.equal(await readB2RenameJob(h.storage, context), null)
  assert.equal(h.queries(), 0)
  await assert.rejects(
    assertB2PathWritable(h.storage, "/B2/new/movie.mp4", context),
    /temporarily disabled/,
  )
  assert.equal(h.queries(), 1)
})
