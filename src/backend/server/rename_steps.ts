import { Hono } from "hono"
import { getUserFromContext, getJwtSecret } from "./middlewares"
import { canWrite, getActualPath } from "../pkg/permission"
import { resolvePath } from "../internal/model/db"
import { getDriver } from "../internal/op/storage"
import { S3Driver, type RenameCopyState } from "../drivers/s3/driver"
import { hmacSha256 } from "../pkg/crypto"
import { safeErrorMessage } from "../pkg/errs"
import { withDirectoryMutation } from "../internal/op/directory-cache"
import {
  advanceB2Rename,
  getB2RenameJob,
  isB2Storage,
  resumeB2Rename,
  startB2Rename,
} from "./b2_rename"

export const renameStepsRouter = new Hono()

async function ownedB2Job(c: any, user: any, path: string) {
  const actualPath = getActualPath(user, path)
  const resolved = await resolvePath(actualPath, c.env)
  if (!resolved.storage || !isB2Storage(resolved.storage))
    throw new Error("B2 rename job not found")
  const job = await getB2RenameJob(c.env, resolved.storage.id)
  if (!job || job.source_virtual !== actualPath)
    throw new Error("B2 rename job not found")
  return { job, storage: resolved.storage }
}

renameStepsRouter.post("/b2/step", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled || !canWrite(user))
    return c.json({ code: 403, message: "Forbidden", data: null }, 403)
  c.header("Cache-Control", "private, no-store")
  try {
    const { path } = await c.req.json()
    const { job, storage } = await ownedB2Job(c, user, path)
    const result = await withDirectoryMutation([storage], { env: c.env }, () =>
      advanceB2Rename(c.env, storage, job.id),
    )
    return c.json({
      code: 200,
      message: "success",
      data: result
        ? {
            jobId: result.id,
            state: result.state,
            processed: result.processed,
            discovered: result.scanned,
            error: result.error,
            done: false,
          }
        : { done: true },
    })
  } catch (error) {
    if (String(error).includes("B2 rename job not found"))
      return c.json({ code: 200, message: "success", data: { done: true } })
    return c.json({ code: 500, message: safeErrorMessage(error), data: null })
  }
})

renameStepsRouter.post("/b2/status", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled || !canWrite(user))
    return c.json({ code: 403, message: "Forbidden", data: null }, 403)
  c.header("Cache-Control", "private, no-store")
  try {
    const { path } = await c.req.json()
    const { job } = await ownedB2Job(c, user, path)
    return c.json({
      code: 200,
      message: "success",
      data: {
        jobId: job.id,
        state: job.state,
        processed: job.processed,
        discovered: job.scanned,
        error: job.error,
        done: false,
      },
    })
  } catch (error) {
    if (String(error).includes("B2 rename job not found"))
      return c.json({ code: 200, message: "success", data: { done: true } })
    return c.json({ code: 500, message: safeErrorMessage(error), data: null })
  }
})

renameStepsRouter.post("/b2/resume", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled || !canWrite(user))
    return c.json({ code: 403, message: "Forbidden", data: null }, 403)
  c.header("Cache-Control", "private, no-store")
  try {
    const { path } = await c.req.json()
    const { job, storage } = await ownedB2Job(c, user, path)
    await resumeB2Rename(c.env, storage.id, job.id)
    return c.json({ code: 200, message: "success", data: { jobId: job.id } })
  } catch (error) {
    return c.json({ code: 500, message: safeErrorMessage(error), data: null })
  }
})

export async function prepareB2Rename(
  c: any,
  user: any,
  path: string,
  name: string,
) {
  const actualPath = getActualPath(user, path)
  const resolved = await resolvePath(actualPath, c.env)
  if (!resolved.storage || !isB2Storage(resolved.storage)) return null
  if (resolved.relative === "/")
    throw new Error("A storage mount root cannot be renamed")
  const driver = await getDriver(resolved.storage.driver, resolved.storage)
  if (!(driver instanceof S3Driver)) return null
  const item = await driver.get(actualPath, resolved.physical!)
  if (!item.is_dir) return null
  const job = await withDirectoryMutation(
    [resolved.storage],
    { env: c.env },
    () =>
      startB2Rename(
        c.env,
        resolved.storage,
        actualPath,
        resolved.physical!,
        name,
      ),
  )
  return {
    jobId: job.id,
    state: job.state,
    processed: 0,
    discovered: 0,
    done: false,
  }
}
type Ticket = {
  path: string
  actualPath: string
  name: string
  owner: number
  storage: number
  fingerprint: string
  expires: number
  copy?: RenameCopyState
}
const fingerprint = (storage: any, secret: string) =>
  hmacSha256(
    JSON.stringify([storage.driver, storage.mount_path, storage.addition]),
    secret,
  )
export async function signRenameTicket(
  ticket: Ticket,
  secret: string,
): Promise<string> {
  const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url")
  return payload + "." + (await hmacSha256("rename-step:" + payload, secret))
}
export async function readRenameTicket(
  token: string,
  secret: string,
): Promise<Ticket> {
  if (typeof token !== "string" || token.length > 1048576)
    throw new Error("Invalid rename session")
  const [payload, sig, extra] = token.split(".")
  const expected = await hmacSha256("rename-step:" + payload, secret)
  let diff = expected.length ^ (sig?.length || 0)
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ (sig?.charCodeAt(i) || 0)
  if (diff || extra) throw new Error("Invalid rename session")
  const ticket = JSON.parse(Buffer.from(payload, "base64url").toString())
  if (!Number.isFinite(ticket.expires) || ticket.expires < Date.now())
    throw new Error("Rename session expired")
  return ticket
}

// Each request handles at most one object. No Worker-local job map or
// waitUntil: signed continuation tickets survive isolate changes.
renameStepsRouter.post("/step", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled || !canWrite(user))
    return c.json({ code: 403, message: "Forbidden", data: null }, 403)
  c.header("Cache-Control", "private, no-store")
  try {
    const { ticket: token } = await c.req.json()
    const secret = await getJwtSecret(c)
    const ticket = await readRenameTicket(token, secret)
    if (ticket.owner !== user.id)
      throw new Error("Rename session belongs to another account")
    if (getActualPath(user, ticket.path) !== ticket.actualPath)
      throw new Error("Account root changed; rename paused")
    const resolved = await resolvePath(ticket.actualPath, c.env)
    const storage = resolved.storage
    if (
      !storage ||
      storage.disabled ||
      storage.id !== ticket.storage ||
      (await fingerprint(storage, secret)) !== ticket.fingerprint
    )
      throw new Error("Storage changed; rename paused")
    const driver = await getDriver(storage.driver, storage)
    if (!(driver instanceof S3Driver))
      throw new Error("Storage changed; rename paused")
    const result = await withDirectoryMutation([storage], { env: c.env }, () =>
      driver.renameStep(resolved.physical!, ticket.name, ticket.copy),
    )
    const next = result.done
      ? undefined
      : await signRenameTicket({ ...ticket, copy: result.copy }, secret)
    return c.json({
      code: 200,
      message: "success",
      data: { ...result, copy: undefined, ticket: next },
    })
  } catch (error) {
    return c.json({ code: 500, message: safeErrorMessage(error), data: null })
  }
})

export async function prepareRenameTicket(
  c: any,
  user: any,
  path: string,
  name: string,
): Promise<string | undefined> {
  const resolved = await resolvePath(getActualPath(user, path), c.env)
  if (!resolved.storage || resolved.storage.disabled) return undefined
  const driver = await getDriver(resolved.storage.driver, resolved.storage)
  if (
    !(driver instanceof S3Driver) ||
    !(await driver.prepareRenameSteps(resolved.physical!, name))
  )
    return undefined
  const secret = await getJwtSecret(c)
  return signRenameTicket(
    {
      path,
      actualPath: getActualPath(user, path),
      name,
      owner: user.id,
      storage: resolved.storage.id,
      fingerprint: await fingerprint(resolved.storage, secret),
      expires: Date.now() + 86400000,
    },
    secret,
  )
}
