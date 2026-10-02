import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { sign } from "hono/jwt"
import { saveDb } from "../internal/model/db"
import { recentPath, recentRepository } from "../internal/model/recent"
import { recentRouter } from "./recent"
import type { Driver } from "../internal/model/store/types"
function memory() {
  const values = new Map<string, string>()
  const driver: Driver = {
    name: "test",
    health: async () => ({}),
    isAvailable: async () => true,
    init: async () => {},
    get: async (k) => values.get(k) || null,
    put: async (k, v) => {
      values.set(k, v)
    },
    delete: async (k) => {
      values.delete(k)
    },
    list: async (p) => [...values.keys()].filter((k) => k.startsWith(p)),
  }
  return { driver, values }
}
const user = { id: 3, role: 0, permission: 0, base_path: "/B2" }
const file = (path = "/Documents/a #1.pdf") => ({
  path,
  size: 42,
  type: 0,
  raw_url: "secret",
  pwd: "secret",
  opened_at: 1,
  user_id: 99,
})
test("records survive a second device, deduplicate and keep metadata free of secrets", async () => {
  const { driver, values } = memory()
  const a = await recentRepository(driver, {}, user),
    b = await recentRepository(driver, {}, user)
  await a.record(file(), 100)
  await b.record(file("/b.mp4"), 200)
  await b.record(file(), 300)
  assert.deepEqual(
    (await a.list(301)).map((x) => x.path),
    [file().path, "/b.mp4"],
  )
  const record = JSON.parse([...values.values()][0])
  assert.deepEqual(Object.keys(record).sort(), [
    "name",
    "opened_at",
    "path",
    "size",
    "type",
  ])
  assert.equal(record.name, "a #1.pdf")
  assert.equal(record.opened_at, 300)
})
test("simultaneous devices do not overwrite unrelated files", async () => {
  const { driver } = memory()
  const a = await recentRepository(driver, {}, user),
    b = await recentRepository(driver, {}, user)
  await Promise.all([
    a.record(file("/a.pdf"), 100),
    b.record(file("/b.pdf"), 101),
  ])
  assert.equal((await a.list(102)).length, 2)
})
test("history and clear are isolated by account and current root", async () => {
  const { driver } = memory()
  const a = await recentRepository(driver, {}, user),
    b = await recentRepository(driver, {}, { ...user, id: 4 }),
    changed = await recentRepository(
      driver,
      {},
      { ...user, base_path: "/Other" },
    )
  await a.record(file(), 100)
  await b.record(file(), 100)
  assert.equal((await changed.list(101)).length, 0)
  await a.clear()
  assert.equal((await b.list(101)).length, 1)
  assert.equal((await a.list(101)).length, 0)
})
test("removing history does not touch configuration or another record", async () => {
  const { driver, values } = memory()
  values.set("db", "configuration")
  const a = await recentRepository(driver, {}, user)
  await a.record(file(), 100)
  await a.record(file("/b.pdf"), 101)
  await a.remove(file().path)
  assert.equal(values.get("db"), "configuration")
  assert.deepEqual(
    (await a.list(102)).map((x) => x.path),
    ["/b.pdf"],
  )
})
test("retention sorts, bounds and prunes old history", async () => {
  const { driver, values } = memory()
  const a = await recentRepository(driver, {}, user)
  const now = Date.now()
  for (let i = 0; i < 105; i++) await a.record(file(`/file-${i}.pdf`), now + i)
  await a.record(file("/expired.pdf"), now - 91 * 86400000)
  const list = await a.list(now + 200)
  assert.equal(list.length, 100)
  assert.equal(list[0].path, "/file-104.pdf")
  assert.equal(values.size, 100)
})
test("invalid paths and non-file metadata are rejected", async () => {
  const { driver } = memory()
  const a = await recentRepository(driver, {}, user)
  for (const path of [
    "https://example.com/a",
    "/../private",
    "/@s/id/a",
    "/a\\b",
    "/",
    "/a\nsecret",
  ]) {
    assert.throws(() => recentPath(path))
    await assert.rejects(a.record(file(path)))
  }
  await assert.rejects(a.record({ ...file(), size: -1 }))
  await assert.rejects(recentRepository(driver, {}, { ...user, role: 1 }))
})
test("retention preserves a file reopened by another device while listing", async () => {
  const { driver, values } = memory()
  const a = await recentRepository(driver, {}, user)
  const now = Date.now()
  await a.record(file(), now - 91 * 86400000)
  const get = driver.get
  let reopened = false
  driver.get = async (key, env) => {
    const old = await get(key, env)
    if (!reopened && old) {
      reopened = true
      values.set(key, JSON.stringify({ ...JSON.parse(old), opened_at: now }))
    }
    return old
  }
  await a.list(now)
  assert.equal(values.size, 1)
  assert.equal((await a.list(now))[0].opened_at, now)
})
test("authenticated APIs synchronize only the current account", async () => {
  const values = new Map<string, string>()
  const env: any = {
    JWT_SECRET: "recent-test-secret-long-enough-32-chars",
    DB_DRIVER: "kv",
    KV: {
      get: async (k: string) => values.get(k) || null,
      put: async (k: string, v: string) => {
        values.set(k, v)
      },
      delete: async (k: string) => {
        values.delete(k)
      },
      list: async ({ prefix }: any) => ({
        keys: [...values.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((key) => ({ key })),
        complete: true,
      }),
    },
  }
  await saveDb(
    {
      settings: [],
      storages: [],
      shares: [],
      users: [
        { ...user, username: "reader", disabled: false },
        { ...user, id: 4, username: "other", disabled: false },
        { ...user, id: 2, role: 1, username: "guest", disabled: false },
      ],
    },
    env,
    { force: true },
  )
  const app = new Hono().route("/recent", recentRouter)
  const token = async (id: number) =>
    sign(
      { id, exp: Math.floor(Date.now() / 1000) + 60 },
      env.JWT_SECRET,
      "HS256",
    )
  const request = async (id: number, endpoint: string, body?: any) =>
    app.request(
      `/recent/${endpoint}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: await token(id),
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    )
  assert.equal((await request(3, "record", file())).status, 200)
  assert.equal((await (await request(3, "list")).json()).data.content.length, 1)
  assert.equal((await (await request(4, "list")).json()).data.content.length, 0)
  assert.equal((await app.request("/recent/list", {}, env)).status, 401)
  assert.equal((await request(2, "list")).status, 401)
  assert.equal((await request(3, "record", file("/../bad"))).status, 400)
  assert.equal((await request(4, "clear", {})).status, 200)
  assert.equal((await (await request(3, "list")).json()).data.content.length, 1)
  assert.equal((await request(3, "delete", { path: file().path })).status, 200)
  assert.equal((await (await request(3, "list")).json()).data.content.length, 0)
})
