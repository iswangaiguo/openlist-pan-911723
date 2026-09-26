import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { sign } from "hono/jwt"
import { fsRouter } from "./fs"
import {
  saveDb,
  __setStoreBackendLoaderForTest,
  __resetDbCacheForTest,
} from "../internal/model/db"
import { d1 } from "../internal/op/directory-cache.test-helper"
import { S3Driver } from "../drivers/s3/driver"

const app = new Hono()
app.route("/api/fs", fsRouter)
const env = {
  DB: d1(),
  DIRECTORY_CACHE_ENABLED: "true",
  JWT_SECRET: "test-directory-cache-signing-secret-32-chars",
}
const storage = {
  id: 1,
  mount_path: "/B2",
  driver: "S3",
  modified: "directory-test",
  status: "work",
  addition: {
    bucket: "test",
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    access_key_id: "test",
    secret_access_key: "test",
  },
}
let db: any = {
  settings: [
    { key: "sign_all", value: "true" },
    { key: "link_expiration", value: "1" },
  ],
  users: [
    {
      id: 3,
      username: "reader",
      role: 0,
      permission: 128,
      base_path: "/B2",
      disabled: false,
    },
  ],
  storages: [storage],
  metas: [],
  shares: [],
}
__resetDbCacheForTest()
__setStoreBackendLoaderForTest(async () => ({
  name: "test",
  isConfigured: async () => true,
  load: async () => structuredClone(db),
  save: async (next: any) => {
    db = structuredClone(next)
    return true
  },
}))
async function request(token: string, body: any = {}, endpoint = "list") {
  return app.request(
    `/api/fs/${endpoint}`,
    {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/folder", ...body }),
    },
    env,
  )
}

test("warm directories still enforce current auth/meta, freshly sign links, and invalidate after deletion", async (t) => {
  await saveDb(db, env)
  const token = await sign(
    { id: 3, exp: Math.floor(Date.now() / 1000) + 600 },
    env.JWT_SECRET,
    "HS256",
  )
  let files = [
    {
      name: "movie.mp4",
      size: 12,
      is_dir: false,
      modified: "2026-09-26",
      type: 2,
      sign: "",
    },
  ]
  let lists = 0
  t.mock.method(S3Driver.prototype, "listMetadata", async () => {
    lists++
    return structuredClone(files)
  })
  t.mock.method(S3Driver.prototype, "removeObject", async () => {
    files = []
  })
  const first = await request(token)
  const initial: any = await first.json()
  assert.equal(initial.code, 200)
  assert.equal(first.headers.get("X-Openlist-Directory-Cache"), "MISS")
  assert.ok(initial.data.content[0].sign)
  const now = Date.now()
  t.mock.method(Date, "now", () => now + 2000)
  const warm = await request(token)
  assert.equal(warm.headers.get("X-Openlist-Directory-Cache"), "HIT")
  assert.equal(lists, 1)
  assert.notEqual(
    (await warm.json()).data.content[0].sign,
    initial.data.content[0].sign,
  )
  assert.equal((await request("")).status, 401)
  db.metas = [
    { id: 1, path: "/B2/folder", read_users: "someone-else", apply_sub: true },
  ]
  await saveDb(db, env)
  assert.equal((await request(token)).status, 403)
  assert.equal(lists, 1)
  db.metas = []
  db.users[0].disabled = true
  await saveDb(db, env)
  assert.equal((await request(token)).status, 401)
  db.users[0].disabled = false
  await saveDb(db, env)
  const refreshed = await request(token, { refresh: true })
  assert.equal(refreshed.headers.get("X-Openlist-Directory-Cache"), "REFRESH")
  assert.equal(lists, 2)
  assert.equal(
    (
      await (
        await request(token, { dir: "/folder", names: ["movie.mp4"] }, "remove")
      ).json()
    ).code,
    200,
  )
  const after = await request(token)
  assert.equal((await after.json()).data.total, 0)
  assert.equal(lists, 3)
})
