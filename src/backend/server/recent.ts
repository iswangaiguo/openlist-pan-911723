import { Hono, type Context } from "hono"
import type { UserPermissionObj } from "../pkg/permission"
import { getStorageBackend } from "../internal/model/store/backend"
import { recentPath, recentRepository } from "../internal/model/recent"
import { getUserFromContext } from "./middlewares"

type RecentEnv = {
  Bindings: Record<string, any>
  Variables: { "recent-user": UserPermissionObj }
}
export const recentRouter = new Hono<RecentEnv>()
recentRouter.use("*", async (c, next) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled || user.role === 1 || !user.id)
    return c.json({ code: 401, message: "Login required", data: null }, 401)
  c.set("recent-user", user)
  c.header("Cache-Control", "no-store")
  await next()
})
async function repository(c: Context<RecentEnv>) {
  const { driver } = await getStorageBackend(c.env)
  await driver.init(c.env)
  return recentRepository(driver, c.env, c.get("recent-user"))
}
recentRouter.get("/list", async (c) => {
  try {
    const content = await (await repository(c)).list()
    return c.json({
      code: 200,
      message: "success",
      data: { content, total: content.length },
    })
  } catch {
    return c.json(
      { code: 500, message: "Unable to load recent files", data: null },
      500,
    )
  }
})
recentRouter.post("/record", async (c) => {
  const body = await c.req.json().catch(() => null)
  try {
    recentPath(body?.path)
    if (
      !Number.isFinite(body?.size) ||
      body.size < 0 ||
      !Number.isInteger(body?.type) ||
      body.type < 0 ||
      body.type > 6
    )
      throw new Error()
  } catch {
    return c.json(
      { code: 400, message: "Invalid file metadata", data: null },
      400,
    )
  }
  try {
    const data = await (await repository(c)).record(body)
    return c.json({ code: 200, message: "success", data })
  } catch {
    return c.json(
      { code: 500, message: "Unable to save recent file", data: null },
      500,
    )
  }
})
recentRouter.post("/delete", async (c) => {
  const body = await c.req.json().catch(() => null)
  try {
    recentPath(body?.path)
  } catch {
    return c.json({ code: 400, message: "Invalid file path", data: null }, 400)
  }
  try {
    await (await repository(c)).remove(body.path)
    return c.json({ code: 200, message: "success", data: null })
  } catch {
    return c.json(
      { code: 500, message: "Unable to remove recent file", data: null },
      500,
    )
  }
})
recentRouter.post("/clear", async (c) => {
  try {
    await (await repository(c)).clear()
    return c.json({ code: 200, message: "success", data: null })
  } catch {
    return c.json(
      { code: 500, message: "Unable to clear recent files", data: null },
      500,
    )
  }
})
