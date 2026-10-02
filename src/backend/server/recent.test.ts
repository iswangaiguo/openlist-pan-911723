import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { sign } from "hono/jwt"
import { saveDb } from "../internal/model/db"
import { recentPath, recentRepository } from "../internal/model/recent"
import { recentRouter } from "./recent"
import type { Driver } from "../internal/model/store/types"
import { kvDriver } from "../internal/model/store/driver/kv"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { d1Driver } from "../internal/model/store/driver/d1"
import { OpenListDB } from "../durable-objects/OpenListDB"
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
  const record = [...values.values()]
    .map((v) => JSON.parse(v))
    .find((v) => v.path === file().path)
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
  assert.equal(
    [...values.values()].filter((v) => JSON.parse(v).path).length,
    100,
  )
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
    if (!reopened && old && JSON.parse(old).path) {
      reopened = true
      values.set(key, JSON.stringify({ ...JSON.parse(old), opened_at: now }))
    }
    return old
  }
  await a.list(now)
  assert.equal([...values.values()].filter((v) => JSON.parse(v).path).length, 1)
  assert.equal((await a.list(now))[0].opened_at, now)
})
test("authenticated APIs synchronize only the current account", async () => {
  const values = new Map<string, string>()
  const validKey = (key: string) => {
    if (!/^[A-Za-z0-9_]+$/.test(key))
      throw new Error(
        "EdgeOne KV key can only contain letters, numbers and underscores",
      )
  }
  const env: any = {
    JWT_SECRET: "recent-test-secret-long-enough-32-chars",
    DB_DRIVER: "kv",
    KV: {
      get: async (k: string) => {
        validKey(k)
        return values.get(k) || null
      },
      put: async (k: string, v: string) => {
        validKey(k)
        values.set(k, v)
      },
      delete: async (k: string) => {
        validKey(k)
        values.delete(k)
      },
      list: async ({ prefix }: any) => {
        validKey(prefix)
        return {
          keys: [...values.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((key) => ({ key })),
          complete: true,
        }
      },
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
  assert.equal((await request(3, "list")).status, 200)
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

test("Cloudflare KV listing uses name and opaque cursors, including empty pages", async () => {
  const cursors: string[] = []
  const pages = [
    {
      keys: [{ name: "openlist_a" }],
      list_complete: false,
      cursor: "opaque-page-2",
    },
    { keys: [], list_complete: false, cursor: "opaque-page-3" },
    { keys: [{ name: "openlist_b" }], list_complete: true, cursor: "" },
  ]
  const env = {
    KV: {
      get: async () => null,
      put: async () => {},
      list: async ({ prefix, cursor }: any) => {
        assert.equal(prefix, "openlist_")
        assert.ok(
          cursors.length < pages.length,
          "must not repeat a completed page",
        )
        cursors.push(cursor)
        return pages[cursors.length - 1]
      },
    },
  }
  assert.deepEqual(await kvDriver.list("openlist_", env), [
    "openlist_a",
    "openlist_b",
  ])
  assert.deepEqual(cursors, ["", "opaque-page-2", "opaque-page-3"])
})

test("EdgeOne pagination uses its last key and rejects a repeated unfinished page", async () => {
  const cursors: string[] = []
  const env = {
    KV: {
      get: async () => null,
      put: async () => {},
      list: async ({ cursor }: any) => {
        cursors.push(cursor)
        return cursors.length === 1
          ? { keys: [{ key: "openlist_a" }], complete: false }
          : { keys: [{ key: "openlist_b" }], complete: true }
      },
    },
  }
  assert.deepEqual(await kvDriver.list("openlist_", env), [
    "openlist_a",
    "openlist_b",
  ])
  assert.deepEqual(cursors, ["", "openlist_a"])
  env.KV.list = async () => ({ keys: [{ key: "openlist_a" }], complete: false })
  await assert.rejects(kvDriver.list("openlist_", env), /did not advance/)
})

test("existing Cloudflare records remain readable and removable without touching other accounts", async () => {
  const values = new Map<string, string>()
  const reads: string[] = []
  const env = {
    KV: {
      get: async (k: string) => {
        reads.push(k)
        return values.get(k) ?? null
      },
      put: async (k: string, v: string) => {
        values.set(k, v)
      },
      delete: async (k: string) => {
        values.delete(k)
      },
      list: async ({ prefix }: any) => ({
        keys: [...values.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cursor: "",
      }),
    },
  }
  const hash = (s: string) => createHash("sha256").update(s).digest("hex")
  const prefix = `openlist:recent:v1:${user.id}:${hash(user.base_path)}:`
  const otherPrefix = `openlist:recent:v1:4:${hash(user.base_path)}:`
  values.set("db", "configuration")
  for (const path of [file().path, "/b.pdf"])
    values.set(
      prefix + hash(path),
      JSON.stringify({ ...file(path), opened_at: 100 }),
    )
  values.set(
    otherPrefix + hash(file().path),
    JSON.stringify({ ...file(), opened_at: 101 }),
  )
  const a = await recentRepository(kvDriver, env, user)
  assert.equal((await a.list(102)).length, 2)
  assert.equal(
    reads.some((k) => k.startsWith(otherPrefix)),
    false,
  )
  await a.record(file(), 200)
  const list = await a.list(201)
  assert.equal(list.length, 2)
  assert.equal(list[0].opened_at, 200)
  assert.equal("raw_url" in list[0], false)
  await a.remove(file().path)
  assert.deepEqual(
    (await a.list(202)).map((x) => x.path),
    ["/b.pdf"],
  )
  await a.clear()
  const secondDevice = await recentRepository(kvDriver, env, user)
  assert.equal((await secondDevice.list(203)).length, 0)
  assert.equal(values.get("db"), "configuration")
  assert.ok(values.has(otherPrefix + hash(file().path)))
})

test("Cloudflare recent API loads populated history without exhausting KV operations", async () => {
  const values = new Map<string, string>()
  let lists = 0
  const env: any = {
    JWT_SECRET: "cloudflare-recent-test-secret",
    DB_DRIVER: "kv",
    KV: {
      get: async (k: string) => values.get(k) ?? null,
      put: async (k: string, v: string) => {
        values.set(k, v)
      },
      delete: async (k: string) => {
        values.delete(k)
      },
      list: async ({ prefix }: any) => {
        // A populated terminal Cloudflare page is returned again if the caller
        // ignores list_complete. Simulate the platform operation budget.
        if (++lists > 12) throw new Error("KV operation limit exceeded")
        return {
          keys: [...values.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((name) => ({ name })),
          list_complete: true,
          cursor: "",
        }
      },
    },
  }
  await saveDb(
    {
      settings: [],
      storages: [],
      shares: [],
      users: [{ ...user, username: "reader", disabled: false }],
    },
    env,
    { force: true },
  )
  const hash = (s: string) => createHash("sha256").update(s).digest("hex")
  values.set(
    `openlist:recent:v1:${user.id}:${hash(user.base_path)}:${hash(file().path)}`,
    JSON.stringify({ ...file(), opened_at: Date.now() - 1000 }),
  )
  const app = new Hono().route("/recent", recentRouter)
  const token = await sign(
    { id: user.id, exp: Math.floor(Date.now() / 1000) + 60 },
    env.JWT_SECRET,
    "HS256",
  )
  const response = await app.request(
    "/recent/list",
    { headers: { Authorization: token } },
    env,
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.data.content[0].path, file().path)
  assert.ok(lists <= 2, "listing should finish at a terminal page")
})

test("a legacy index cache write failure does not block record, list or clear", async () => {
  const { driver, values } = memory()
  const put = driver.put
  driver.put = async (key, value, env) => {
    if (key.startsWith("openlist_recent_legacy_v1_"))
      throw new Error("per-key write rate exceeded")
    await put(key, value, env)
  }
  const a = await recentRepository(driver, {}, user)
  await a.record(file(), 100)
  assert.equal((await a.list(101)).length, 1)
  await a.clear()
  assert.equal((await a.list(102)).length, 0)
  assert.equal(values.size, 0)
})

// Execute real SQLite statements while enforcing Cloudflare's 50-byte LIKE
// pattern limit. Unrestricted desktop SQLite alone missed the production bug.
function sqliteBinding() {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.function("like", (pattern, value) => {
    const p = String(pattern)
    if (Buffer.byteLength(p) > 50)
      throw new Error("LIKE or GLOB pattern too complex")
    const regex = p
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("%", ".*")
      .replaceAll("_", ".")
    return new RegExp("^" + regex + "$", "i").test(String(value)) ? 1 : 0
  })
  function prepare(sql: string) {
    let params: any[] = []
    return {
      sql,
      get params() {
        return params
      },
      bind(...args: any[]) {
        params = args
        return this
      },
      async first() {
        return sqlite.prepare(sql).get(...params) ?? null
      },
      async all() {
        return { success: true, results: sqlite.prepare(sql).all(...params) }
      },
      async run() {
        sqlite.prepare(sql).run(...params)
        return { success: true, results: [] }
      },
    }
  }
  const binding = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      return statements.map((s) => ({
        success: true,
        results: sqlite.prepare(s.sql).all(...s.params),
      }))
    },
  }
  return { sqlite, binding }
}

test("D1 SQL recent APIs work with the production LIKE limit and preserve account data", async () => {
  const { sqlite, binding } = sqliteBinding()
  try {
    const env: any = {
      DB: binding,
      DB_DRIVER: "d1",
      DB_FORMAT: "sql",
      DB_CIPHER: "aes-256-gcm",
      JWT_SECRET: "d1-recent-local-test-secret",
    }
    const admin = {
      ...user,
      id: 1,
      username: "admin",
      role: 2,
      base_path: "/",
      disabled: false,
    }
    const other = { ...admin, id: 4, username: "other", role: 0 }
    await saveDb(
      { settings: [], users: [admin, other], storages: [], shares: [] },
      env,
      { force: true },
    )
    assert.throws(() =>
      sqlite.prepare("SELECT 'test' LIKE ?").get("x".repeat(64) + "%"),
    )
    const request = async (id: number, action: string, body?: any) => {
      const token = await sign(
        { id, exp: Math.floor(Date.now() / 1000) + 60 },
        env.JWT_SECRET,
        "HS256",
      )
      return new Hono().route("/recent", recentRouter).request(
        "/recent/" + action,
        {
          method: body ? "POST" : "GET",
          headers: { Authorization: token, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        env,
      )
    }
    assert.equal((await request(1, "record", file())).status, 200)
    assert.equal((await request(4, "record", file("/other.txt"))).status, 200)
    const hash = (s: string) => createHash("sha256").update(s).digest("hex")
    await d1Driver.put(
      `openlist:recent:v1:1:${hash("/")}:${hash(file().path)}`,
      JSON.stringify({ ...file(), opened_at: Date.now() - 1000 }),
      env,
    )
    // Rebuild the optional legacy cache to simulate upgrading an existing site.
    await d1Driver.delete(`openlist_recent_legacy_v1_1_${hash("/")}`, env)
    const listed = await request(1, "list")
    assert.equal(listed.status, 200)
    assert.deepEqual(
      (await listed.json()).data.content.map((x: any) => x.path),
      [file().path],
    )
    assert.equal(
      (await request(1, "delete", { path: file().path })).status,
      200,
    )
    assert.equal((await (await request(1, "list")).json()).data.total, 0)
    assert.equal((await request(1, "record", file("/new.txt"))).status, 200)
    assert.equal((await request(1, "clear", {})).status, 200)
    assert.equal((await (await request(1, "list")).json()).data.total, 0)
    assert.equal(
      (await (await request(4, "list")).json()).data.content[0].path,
      "/other.txt",
    )
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM x_users").get()!.n,
      2,
    )
  } finally {
    sqlite.close()
  }
})

test("D1 and SQLite Durable Objects list long and literal Unicode prefixes precisely", async () => {
  const { sqlite, binding } = sqliteBinding()
  try {
    const env = { DB: binding }
    const object = new OpenListDB({
      storage: {
        sql: {
          exec(sql: string, ...params: any[]) {
            return { toArray: () => sqlite.prepare(sql).all(...params) }
          },
        },
      },
    })
    await d1Driver.init(env)
    const prefixes = [
      "x".repeat(100),
      "with_%",
      "Case_",
      "case_",
      "文件📁",
      "\u{10ffff}",
      "a\u{10ffff}",
      "\ud7ff",
      "",
    ]
    const keys = [
      "withXX",
      "With_%wrong",
      "case_other",
      "文件📂other",
      "a\u{10ffff}suffix",
      "b",
      "\ue000other",
    ]
    for (const prefix of prefixes.filter(Boolean))
      keys.push(prefix, prefix + "entry")
    for (const key of keys) await d1Driver.put(key, "test", env)
    for (const prefix of prefixes) {
      const expected = [...new Set(keys)]
        .filter((k) => k.startsWith(prefix))
        .sort()
      assert.deepEqual((await d1Driver.list(prefix, env)).sort(), expected)
      assert.deepEqual((await object.kvList(prefix)).sort(), expected)
    }
    const plan = sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key",
      )
      .all("long-prefix", "long-prefiy")
    assert.match(String(plan[0].detail), /SEARCH.*INDEX/)
  } finally {
    sqlite.close()
  }
})
