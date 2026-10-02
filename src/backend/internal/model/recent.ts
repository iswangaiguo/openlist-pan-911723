import type { Driver } from "./store/types"
import { encodeKeyPart } from "./store/keycodec"
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
    user.id < 0 ||
    user.role === 1 ||
    user.disabled
  )
    throw new Error("Login required")
  const root = await digest(user.base_path || "/")
  const legacyPrefix = `openlist:recent:v1:${user.id}:${root}:`
  // The shared codec follows EdgeOne's letters/digits/underscores constraint.
  const prefix = encodeKeyPart(legacyPrefix)
  const legacyIndex = `openlist_recent_legacy_v1_${user.id}_${root}`
  const ownKey = (k: unknown, p: string): k is string =>
    typeof k === "string" &&
    k.startsWith(p) &&
    /^[0-9a-f]{64}$/.test(k.slice(p.length))
  const legacyKeys = async (): Promise<string[]> => {
    const stored = await driver.get(legacyIndex, env)
    if (stored) {
      try {
        const keys = JSON.parse(stored)
        if (Array.isArray(keys))
          return [
            ...new Set<string>(
              keys.filter((k: unknown) => ownKey(k, legacyPrefix)),
            ),
          ]
      } catch {}
    }
    // Use a legal prefix even on strict KV providers. Only retain addresses
    // belonging to this account/root; never read another account's values.
    const keys = (await driver.list("openlist", env)).filter((k) =>
      ownKey(k, legacyPrefix),
    )
    // This index is a cache, not history data. Concurrent first visits can hit
    // Cloudflare's per-key write rate; a cache failure must not block records.
    await driver.put(legacyIndex, JSON.stringify(keys), env).catch(() => {})
    return keys
  }
  const allKeys = async () => {
    const [current, legacy] = await Promise.all([
      driver.list(prefix, env),
      legacyKeys(),
    ])
    return [
      ...new Set([...current.filter((k) => ownKey(k, prefix)), ...legacy]),
    ]
  }
  const key = async (path: string) => prefix + (await digest(recentPath(path)))
  const read = async (k: string): Promise<RecentFile | undefined> => {
    const raw = await driver.get(k, env)
    if (!raw) return
    try {
      const data = JSON.parse(raw)
      const path = recentPath(data.path)
      if (
        (k !== (await key(path)) &&
          k !== legacyPrefix + (await digest(path))) ||
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
      const legacy = legacyPrefix + (await digest(path))
      const [old, oldLegacy] = await Promise.all([
        read(k),
        legacyKeys().then((keys) =>
          keys.includes(legacy) ? read(legacy) : undefined,
        ),
      ])
      const entry: RecentFile = {
        path,
        name: path.split("/").pop()!,
        size: body.size,
        type: body.type,
        opened_at: Math.max(
          now,
          old?.opened_at || 0,
          oldLegacy?.opened_at || 0,
        ),
      }
      await driver.put(k, JSON.stringify(entry), env)
      return entry
    },
    list: async (now = Date.now()) => {
      const keys = await allKeys()
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
      const seen = new Set<string>()
      const visible: RecentFile[] = []
      for (const item of entries) {
        if (seen.has(item.file.path) || visible.length >= LIMIT)
          stale.push({ key: item.key, opened_at: item.file.opened_at })
        else {
          seen.add(item.file.path)
          visible.push(item.file)
        }
      }
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
      return visible
    },
    remove: async (path: string) => {
      await driver.delete(await key(path), env)
      const legacy = legacyPrefix + (await digest(recentPath(path)))
      if ((await legacyKeys()).includes(legacy))
        await driver.delete(legacy, env)
    },
    clear: async () => {
      const keys = await allKeys()
      for (let i = 0; i < keys.length; i += 8)
        await Promise.all(
          keys.slice(i, i + 8).map((k) => driver.delete(k, env)),
        )
      await driver.put(legacyIndex, "[]", env).catch(() => {})
    },
  }
}
