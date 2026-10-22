import app from "./index"
import { OpenListDB } from "./durable-objects/OpenListDB"
import { getDb } from "./internal/model/db"
import { withDirectoryMutation } from "./internal/op/directory-cache"
import { advanceB2Rename, pendingB2Renames } from "./server/b2_rename"
import { getDriver } from "./internal/op/storage"
import { abortExpiredSessions } from "./internal/upload/multipart"

// Durable Object 类（DB_DRIVER=do 时使用），需在 wrangler.toml 声明
// new_sqlite_classes = ["OpenListDB"] 与对应的 binding。
export { OpenListDB }

export default {
  fetch: app.fetch,
  async scheduled(_event: unknown, env: any): Promise<void> {
    const db = await getDb(env)
    const storages = db.storages || []
    for (const job of await pendingB2Renames(env)) {
      const storage = storages.find((entry: any) => entry.id === job.storage_id)
      if (!storage || storage.disabled) continue
      for (let step = 0; step < 10; step++) {
        const result = await withDirectoryMutation([storage], { env }, () =>
          advanceB2Rename(env, storage, job.id),
        )
        if (!result || result.state === "paused") break
      }
    }
    // Cancel abandoned chunked uploads so their parts stop being billed.
    try {
      await abortExpiredSessions(env, async (session) => {
        const storage = storages.find(
          (entry: any) => entry.id === session.storage_id,
        )
        if (!storage) return // Storage removed: nothing left to cancel.
        const driver: any = await getDriver(storage.driver, storage)
        if (typeof driver.abortUploadSession === "function")
          await driver.abortUploadSession(session.driver_session)
      })
    } catch (error) {
      console.warn("[cron] cancelling expired uploads failed:", error)
    }
  },
}
