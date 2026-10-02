import type { Driver } from "./store/types"
import type { UserPermissionObj } from "../../pkg/permission"

export interface RecentFile {
  path: string
  name: string
  size: number
  type: number
  opened_at: number
}
const LIMIT = 100
const MAX_AGE = 90 * 24 * 60 * 60 * 1000
async function digest(value: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")
}
export function recentPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !value.startsWith("/") ||
    /[\\\x00-\x1f]/.test(value)
  )
    throw new Error("Invalid file path")
  const parts = value.split("/").filter(Boolean)
  if (
    !parts.length ||
    parts.some((p) => p === "." || p === "..") ||
    parts[0].startsWith("@")
  )
    throw new Error("Invalid file path")
  return "/" + parts.join("/")
}
// Separate per-file keys avoid replacing site configuration or losing other
// files when two devices record an opening at the same time.
export async function recentRepository(
  driver: Driver,
  env: any,
  user: UserPermissionObj,
) {
  if (
    !Number.isSafeInteger(user.id) ||
    !user.id ||
    user.role === 1 ||
    user.disabled
  )
    throw new Error("Login required")
  const prefix = `openlist:recent:v1:${user.id}:${await digest(user.base_path || "/")}:`
  const key = async (path: string) => prefix + (await digest(recentPath(path)))
  const read = async (k: string): Promise<RecentFile | undefined> => {
    const raw = await driver.get(k, env)
    if (!raw) return
    try {
      const data = JSON.parse(raw)
      const path = recentPath(data.path)
      if (
        k !== (await key(path)) ||
        !Number.isFinite(data.opened_at) ||
        !Number.isFinite(data.size) ||
        data.size < 0 ||
        !Number.isInteger(data.type)
      )
        return
      return {
        path,
        name: path.split("/").pop()!,
        size: data.size,
        type: data.type,
        opened_at: data.opened_at,
      }
    } catch {
      return
    }
  }
  return {
    record: async (body: any, now = Date.now()) => {
      const path = recentPath(body?.path)
      if (
        !Number.isFinite(body?.size) ||
        body.size < 0 ||
        !Number.isInteger(body?.type) ||
        body.type < 0 ||
        body.type > 6
      )
        throw new Error("Invalid file metadata")
      const k = await key(path)
      const old = await read(k)
      const entry: RecentFile = {
        path,
        name: path.split("/").pop()!,
        size: body.size,
        type: body.type,
        opened_at: Math.max(now, old?.opened_at || 0),
      }
      await driver.put(k, JSON.stringify(entry), env)
      return entry
    },
    list: async (now = Date.now()) => {
      const keys = await driver.list(prefix, env)
      // Bound concurrent remote reads rather than launching every request at once.
      const entries: { key: string; file: RecentFile }[] = []
      const stale: { key: string; opened_at?: number }[] = []
      for (let i = 0; i < keys.length; i += 8) {
        await Promise.all(
          keys.slice(i, i + 8).map(async (k) => {
            const file = await read(k)
            if (file && file.opened_at >= now - MAX_AGE)
              entries.push({ key: k, file })
            else stale.push({ key: k, opened_at: file?.opened_at })
          }),
        )
      }
      entries.sort(
        (a, b) =>
          b.file.opened_at - a.file.opened_at ||
          a.file.path.localeCompare(b.file.path),
      )
      for (const item of entries.slice(LIMIT))
        stale.push({ key: item.key, opened_at: item.file.opened_at })
      // Recheck expired and excess records before pruning: another device may
      // have reopened them during this list request. Bound housekeeping calls.
      for (let i = 0; i < stale.length; i += 8)
        await Promise.allSettled(
          stale.slice(i, i + 8).map(async (item) => {
            const current = await read(item.key)
            if (current?.opened_at === item.opened_at)
              await driver.delete(item.key, env)
          }),
        )
      return entries.slice(0, LIMIT).map((e) => e.file)
    },
    remove: async (path: string) => driver.delete(await key(path), env),
    clear: async () => {
      const keys = await driver.list(prefix, env)
      for (let i = 0; i < keys.length; i += 8)
        await Promise.all(
          keys.slice(i, i + 8).map((k) => driver.delete(k, env)),
        )
    },
  }
}
