import assert from "node:assert/strict"
import { test } from "node:test"
import { uploadDatabase } from "./multipart.test-helper"
import {
  putSession,
  getSession,
  recordPart,
  findReceivingSession,
  snapshot,
  claimCompletion,
  type MultipartSession,
} from "./multipart"

function session(): MultipartSession {
  return {
    upload_id: "test-session",
    scope: "owner-storage",
    file_md5: "",
    state: "receiving",
    attempt: 0,
    path: "/B2/video.mp4",
    size: 21,
    chunk_size: 10,
    total_chunks: 3,
    received: new Set(),
    driver_session: '{"key":"video.mp4","uploadId":"provider-id"}',
    partMd5s: [],
    storage_driver: "S3",
    created_at: Date.now(),
  }
}

test("cold bindings read durable progress; concurrent part writes do not lose ETags", async () => {
  const a = { DB: uploadDatabase() }
  const s = session()
  await putSession(s, a)
  const b = { DB: uploadDatabase(a.DB.sqlite) }
  const stale = (await getSession(s.upload_id, b))!
  await Promise.all([
    recordPart(s, 2, '"tail"', a),
    recordPart(stale, 0, '"first"', b),
  ])
  const loaded = (await getSession(s.upload_id, {
    DB: uploadDatabase(a.DB.sqlite),
  }))!
  assert.deepEqual(loaded.partMd5s, ['"first"', undefined, '"tail"'])
  assert.deepEqual(snapshot(loaded).received, [
    [0, 0],
    [2, 2],
  ])
  assert.equal(snapshot(loaded).received_bytes, 11)
  assert.equal(
    await findReceivingSession(s.path, s.size, "other-owner", b),
    undefined,
  )
  assert.equal(
    (await findReceivingSession(s.path, s.size, s.scope, b))!.upload_id,
    s.upload_id,
  )
  await recordPart(stale, 1, '"middle"', b)
  assert.equal(snapshot((await getSession(s.upload_id, a))!).received_bytes, 21)
})

test("one completion wins; completed uploads remain queryable but are not resumed", async () => {
  const env = { DB: uploadDatabase() }
  const s = session()
  await putSession(s, env)
  const claims = await Promise.all([
    claimCompletion(s, env),
    claimCompletion(s, env),
  ])
  assert.deepEqual(claims, [true, false])
  s.state = "completed"
  await putSession(s, env)
  assert.equal((await getSession(s.upload_id, env))!.state, "completed")
  assert.equal(
    await findReceivingSession(s.path, s.size, s.scope, env),
    undefined,
  )
  env.DB.sqlite.exec("UPDATE openlist_upload_sessions SET expires_at = 0")
  assert.equal(await getSession(s.upload_id, env), undefined)
})

test("oversized streaming chunks are cancelled without buffering the whole request", async () => {
  const { readPartBody } = await import("./multipart")
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(11))
    },
    cancel() {
      cancelled = true
    },
  })
  const req = new Request("https://test/chunk", {
    method: "PUT",
    body: stream,
    duplex: "half",
  } as any)
  assert.equal(await readPartBody(req, 10), undefined)
  assert.equal(cancelled, true)
})
