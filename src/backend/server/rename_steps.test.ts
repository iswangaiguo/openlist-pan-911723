import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { saveDb } from "../internal/model/db"
import { fsRouter } from "./fs"
import { S3Client } from "../drivers/s3/util"
import { readRenameTicket, signRenameTicket } from "./rename_steps"
const secret = "test-only-rename-secret-32-characters"

test("rename continuation signatures reject tampering and expiry", async () => {
  const data = {
    path: "/B2/old",
    actualPath: "/B2/old",
    name: "new",
    owner: 1,
    storage: 1,
    fingerprint: "scope",
    expires: Date.now() + 10000,
  }
  const token = await signRenameTicket(data, secret)
  assert.deepEqual(await readRenameTicket(token, secret), data)
  await assert.rejects(readRenameTicket(token + "x", secret), /Invalid/)
  await assert.rejects(
    readRenameTicket(
      await signRenameTicket({ ...data, expires: 1 }, secret),
      secret,
    ),
    /expired/,
  )
})

test("rename steps bind owner and storage configuration and never execute unsigned input", async (t) => {
  const env: any = { JWT_SECRET: secret }
  const storage = {
    id: 99,
    driver: "s3",
    mount_path: "/B2",
    disabled: false,
    addition: JSON.stringify({
      bucket: "bucket",
      endpoint: "https://s3.example.com",
      access_key_id: "id",
      secret_access_key: "secret",
      force_path_style: true,
    }),
  }
  const db: any = {
    settings: [{ key: "token", value: "rename-admin" }],
    users: [],
    storages: [storage],
    metas: [],
    shares: [],
  }
  await saveDb(db, env)
  t.mock.method(S3Client.prototype, "headObject", async () => null)
  t.mock.method(S3Client.prototype, "firstObject", async () => null)
  let mutation = 0
  t.mock.method(S3Client.prototype, "deleteObject", async () => {
    mutation++
  })
  const app = new Hono()
  app.route("/api/fs", fsRouter)
  const request = (url: string, body: any, auth = true) =>
    app.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: "rename-admin" } : {}),
        },
        body: JSON.stringify(body),
      },
      env,
    )
  assert.equal(
    (await request("/api/fs/rename/step", { ticket: "invalid" }, false)).status,
    403,
  )
  const start: any = await (
    await request("/api/fs/rename", {
      path: "/B2/old",
      name: "new",
      staged: true,
    })
  ).json()
  assert.equal(start.code, 200)
  const token = start.data.ticket
  assert.equal(
    (
      (await (
        await request("/api/fs/rename/step", { ticket: token })
      ).json()) as any
    ).data.done,
    true,
  )
  const data = await readRenameTicket(token, secret)
  assert.equal(
    (
      (await (
        await request("/api/fs/rename/step", {
          ticket: await signRenameTicket(
            { ...data, owner: data.owner + 1 },
            secret,
          ),
        })
      ).json()) as any
    ).code,
    500,
  )
  assert.equal(
    (
      (await (
        await request("/api/fs/rename/step", { ticket: token + "bad" })
      ).json()) as any
    ).code,
    500,
  )
  assert.match(
    (
      (await (
        await request("/api/fs/rename/step", {
          ticket: await signRenameTicket(
            { ...data, actualPath: "/another-root/old" },
            secret,
          ),
        })
      ).json()) as any
    ).message,
    /Account root changed/,
  )
  storage.addition = JSON.stringify({ bucket: "different-bucket" })
  await saveDb(db, env)
  assert.match(
    (
      (await (
        await request("/api/fs/rename/step", { ticket: token })
      ).json()) as any
    ).message,
    /Storage changed/,
  )
  assert.equal(mutation, 0)
})
