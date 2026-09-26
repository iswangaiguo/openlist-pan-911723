import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { sign } from "hono/jwt"
import { saveDb } from "../internal/model/db"
import { fsRouter } from "./fs"
import { meHandler } from "./auth"
import { S3Driver } from "../drivers/s3/driver"

const env = { JWT_SECRET: "test-only-delete-permissions-secret-32-chars" }
const adminToken = "test-admin-token"
const addition = {
  bucket: "private-bucket",
  endpoint: "https://s3.example.com",
  region: "us-west-004",
  access_key_id: "test",
  secret_access_key: "test",
  root_folder_path: "/assets",
  force_path_style: true,
  list_object_version: "v2",
}
const app = new Hono()
app.route("/api/fs", fsRouter)
app.get("/api/me", meHandler)

async function seed(permission = 128, metas: any[] = [], disabled = false) {
  await saveDb(
    {
      settings: [{ key: "token", value: adminToken }],
      users: [
        { id: 1, username: "admin", role: 2, permission: 0, disabled: false },
        {
          id: 3,
          username: "reader",
          role: 0,
          permission,
          disabled,
          base_path: "/B2",
        },
      ],
      storages: [
        {
          id: 1,
          modified: "remove-test",
          mount_path: "/B2",
          driver: "S3",
          addition,
        },
      ],
      metas,
      shares: [],
    },
    env,
  )
  return sign(
    { id: 3, exp: Math.floor(Date.now() / 1000) + 60 },
    env.JWT_SECRET,
    "HS256",
  )
}
function remove(token: string, dir = "/小P", names = ["课程 #1.mp4"]) {
  return app.request(
    "/api/fs/remove",
    {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ dir, names }),
    },
    env,
  )
}

test("me reports effective admin permissions without widening ordinary users", async () => {
  const token = await seed()
  const admin = await app.request(
    "/api/me",
    { headers: { Authorization: adminToken } },
    env,
  )
  assert.equal((await admin.json()).data.permission, 65535)
  const reader = await app.request(
    "/api/me",
    { headers: { Authorization: token } },
    env,
  )
  assert.equal((await reader.json()).data.permission, 128)
  const anonymous = await app.request("/api/me", {}, env)
  assert.equal(anonymous.status, 401)
  await seed(128, [], true)
  assert.equal(
    (await app.request("/api/me", { headers: { Authorization: token } }, env))
      .status,
    401,
  )
})

test("admin and delete-only users delete exactly the selected B2 object", async (t) => {
  const token = await seed()
  const deleted: string[] = []
  t.mock.method(globalThis, "fetch", async (input: any, init: RequestInit) => {
    const url = new URL(String(input))
    assert.equal(url.host, "s3.example.com")
    const path = decodeURIComponent(url.pathname)
    assert.equal(path, "/private-bucket/assets/小P/课程 #1.mp4")
    if (init.method === "HEAD")
      return new Response(null, { headers: { "content-length": "10" } })
    assert.equal(init.method, "DELETE")
    deleted.push(path)
    return new Response(null, { status: 204 })
  })
  assert.equal((await (await remove(token)).json()).code, 200)
  assert.equal((await (await remove(adminToken, "/B2/小P")).json()).code, 200)
  assert.equal(deleted.length, 2)
})

test("upload permission alone and anonymous callers cannot delete", async (t) => {
  const token = await seed(8)
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not reach B2")
  })
  assert.equal((await remove(token)).status, 403)
  assert.equal((await remove("")).status, 403)
  assert.equal(fetch.mock.callCount(), 0)
})

test("directory and child write restrictions reject the entire selection before deleting", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not reach B2")
  })
  for (const path of ["/B2/小P", "/B2/小P/blocked.txt"]) {
    const token = await seed(128, [
      { id: 1, path, write_users: [99], write_users_sub: true },
    ])
    assert.equal(
      (await remove(token, "/小P", ["allowed.txt", "blocked.txt"])).status,
      403,
    )
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test("delete rejects traversal names without contacting storage", async (t) => {
  const token = await seed()
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not reach B2")
  })
  assert.equal((await remove(token, "/小P", ["../other.txt"])).status, 400)
  assert.equal(fetch.mock.callCount(), 0)
})

test("folder deletion stays within the selected prefix, including nested files", async (t) => {
  await seed()
  const deleted: string[] = []
  const listed: string[] = []
  t.mock.method(globalThis, "fetch", async (input: any, init: RequestInit) => {
    const url = new URL(String(input))
    const path = decodeURIComponent(url.pathname)
    if (init.method === "HEAD") return new Response(null, { status: 404 })
    if (init.method === "GET") {
      const prefix = url.searchParams.get("prefix")!
      listed.push(prefix)
      const content =
        prefix === "assets/小P/"
          ? "<Contents><Key>assets/小P/a.txt</Key><Size>1</Size></Contents><CommonPrefixes><Prefix>assets/小P/sub/</Prefix></CommonPrefixes>"
          : "<Contents><Key>assets/小P/sub/b.txt</Key><Size>1</Size></Contents>"
      return new Response(
        `<ListBucketResult><IsTruncated>false</IsTruncated>${content}</ListBucketResult>`,
      )
    }
    assert.equal(init.method, "DELETE")
    assert.ok(path.startsWith("/private-bucket/assets/小P/"))
    deleted.push(path)
    return new Response(null, { status: 204 })
  })
  assert.equal(
    (await (await remove(adminToken, "/B2", ["小P"])).json()).code,
    200,
  )
  assert.deepEqual(listed, ["assets/小P/", "assets/小P/sub/"])
  assert.ok(deleted.includes("/private-bucket/assets/小P/a.txt"))
  assert.ok(deleted.includes("/private-bucket/assets/小P/sub/b.txt"))
  assert.ok(deleted.every((path) => !path.includes("小P/小P")))
})

test("B2 access failures do not report successful deletion", async (t) => {
  await seed()
  const methods: string[] = []
  t.mock.method(globalThis, "fetch", async (_: any, init: RequestInit) => {
    methods.push(init.method!)
    return new Response(
      "<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>",
      { status: 403 },
    )
  })
  const result = await (await remove(adminToken, "/B2/小P")).json()
  assert.equal(result.code, 500)
  assert.deepEqual(methods, ["HEAD"])
})

test("S3 batch callers retain directory plus names semantics", async (t) => {
  const deleted: string[] = []
  t.mock.method(globalThis, "fetch", async (input: any, init: RequestInit) => {
    if (init.method === "DELETE")
      deleted.push(decodeURIComponent(new URL(String(input)).pathname))
    return new Response(null, { status: init.method === "DELETE" ? 204 : 200 })
  })
  await new S3Driver(addition).remove("", "/assets/小P", ["a.txt", "b.txt"])
  assert.deepEqual(deleted, [
    "/private-bucket/assets/小P/a.txt",
    "/private-bucket/assets/小P/b.txt",
  ])
})
