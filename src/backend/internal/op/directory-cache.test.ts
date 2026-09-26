import assert from "node:assert/strict"
import { test } from "node:test"
import { cachedDirectory, withDirectoryMutation } from "./directory-cache"

import { d1 } from "./directory-cache.test-helper"
const storage = {
  id: 1,
  driver: "S3",
  modified: "v1",
  addition: { bucket: "private" },
  cache_expiration: 30,
}
const file = (name = "lesson.mp4") => ({
  name,
  size: 1,
  is_dir: false,
  modified: "2026-09-26",
  type: 2,
  sign: "provider-token",
  raw_url: "https://private.example/?secret=credential",
  raw_url_headers: { Authorization: "secret" },
})
function setup(db = d1()) {
  const statuses: string[] = []
  const context = {
    env: { DB: db, DIRECTORY_CACHE_ENABLED: "true" },
    onDirectoryCache: (s: string) => statuses.push(s),
  }
  let calls = 0
  const load = async () => {
    calls++
    return [file()]
  }
  const read = (st = storage, ctx = context) =>
    cachedDirectory(st, "/a", "/B2/a", ctx, load)
  return { db, context, statuses, load, read, calls: () => calls }
}

test("shared D1 hit across separate instances; only safe metadata persists", async () => {
  const a = setup()
  await a.read()
  const b = setup(d1(a.db.sqlite))
  const result = await b.read()
  assert.equal(b.calls(), 0)
  assert.deepEqual(b.statuses, ["HIT"])
  assert.equal(result[0].name, "lesson.mp4")
  const raw = JSON.stringify(
    a.db.sqlite.prepare("SELECT * FROM openlist_directory_cache").all(),
  )
  assert.ok(!raw.includes("secret"))
  assert.ok(!raw.includes("provider-token"))
  assert.ok(!("raw_url" in result[0]))
})

test("explicit refresh and expiry each fetch latest data", async () => {
  const a = setup()
  await a.read()
  await a.read()
  await a.read(storage, { ...a.context, refreshDirectory: true } as any)
  a.db.sqlite.exec("UPDATE openlist_directory_cache SET expires_at = 0")
  await a.read()
  assert.equal(a.calls(), 3)
  assert.deepEqual(a.statuses, ["MISS", "HIT", "REFRESH", "MISS"])
})

test("storage mutation invalidates other instances and partial failures too", async () => {
  const a = setup()
  const b = setup(d1(a.db.sqlite))
  await a.read()
  await withDirectoryMutation([storage], a.context, async () => {})
  await b.read()
  assert.equal(b.calls(), 1)
  await assert.rejects(
    withDirectoryMutation([storage], a.context, async () => {
      throw Error("partial")
    }),
  )
  await b.read()
  assert.equal(b.calls(), 2)
})

test("slow in-flight pre-mutation listing cannot resurrect stale data", async () => {
  const a = setup()
  let resolve!: (v: any) => void
  let started!: () => void
  const ready = new Promise<void>((r) => {
    started = r
  })
  const slow = cachedDirectory(storage, "/a", "/B2/a", a.context, () => {
    started()
    return new Promise((r) => {
      resolve = r
    })
  })
  await ready
  await withDirectoryMutation([storage], a.context, async () => {})
  resolve([file("old.mp4")])
  await slow
  const result = await a.read()
  assert.equal(result[0].name, "lesson.mp4")
  assert.equal(a.calls(), 1)
})

test("concurrent same-instance misses coalesce and return isolated copies", async () => {
  const a = setup()
  await a.read(storage, { ...a.context, refreshDirectory: true } as any)
  a.db.sqlite.exec("DELETE FROM openlist_directory_cache")
  let count = 0
  const load = async () => {
    count++
    await new Promise((r) => setTimeout(r, 20))
    return [file()]
  }
  const [x, y] = await Promise.all([
    cachedDirectory(storage, "/a", "/a", a.context, load),
    cachedDirectory(storage, "/a", "/a", a.context, load),
  ])
  assert.equal(count, 1)
  x[0].name = "changed"
  assert.equal(y[0].name, "lesson.mp4")
})

test("zero TTL, absent D1 and unsupported drivers bypass; config changes miss", async () => {
  const a = setup()
  await a.read()
  await a.read({ ...storage, addition: { bucket: "other" } })
  assert.equal(a.calls(), 2)
  await a.read({ ...storage, cache_expiration: 0 })
  await a.read({ ...storage, driver: "Local" })
  await cachedDirectory(storage, "/a", "/a", {}, a.load)
  assert.equal(a.calls(), 5)
})

test("read outage falls back but mutation fails before touching storage", async () => {
  let changed = false
  let loads = 0
  const context = {
    env: {
      DIRECTORY_CACHE_ENABLED: "true",
      DB: {
        prepare() {
          throw Error("unavailable")
        },
        batch() {},
      },
    },
  }
  await cachedDirectory(storage, "/a", "/a", context, async () => {
    loads++
    return []
  })
  assert.equal(loads, 1)
  await assert.rejects(
    withDirectoryMutation([storage], context, async () => {
      changed = true
    }),
  )
  assert.equal(changed, false)
})

test("provider errors and oversized payloads never enter shared cache", async () => {
  const a = setup()
  await assert.rejects(
    cachedDirectory(storage, "/a", "/a", a.context, async () => {
      throw Error("B2 denied")
    }),
  )
  await cachedDirectory(storage, "/a", "/a", a.context, async () => [
    file("x".repeat(600000)),
  ])
  assert.equal(
    a.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM openlist_directory_cache")
      .get()!.n,
    0,
  )
})

test("TTL reductions take effect immediately and cache capacity stays bounded", async () => {
  const a = setup()
  await a.read()
  await a.read({ ...storage, cache_expiration: 1 })
  assert.equal(a.calls(), 2)
  const insert = a.db.sqlite.prepare(
    "INSERT INTO openlist_directory_cache VALUES (?, 'extra', 0, ?, ?, '[]')",
  )
  for (let i = 0; i < 260; i++) insert.run(`old-${i}`, Date.now() + 60000, i)
  await a.read({ ...storage, modified: "v2" })
  assert.equal(
    a.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM openlist_directory_cache")
      .get()!.n,
    256,
  )
})
