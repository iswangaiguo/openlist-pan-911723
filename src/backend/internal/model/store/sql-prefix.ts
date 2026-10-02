/** Literal prefix search using SQLite's binary key index, without LIKE limits. */
export function sqliteKeyPrefix(prefix: string): {
  sql: string
  params: string[]
} {
  const points = Array.from(prefix)
  for (let i = points.length - 1; i >= 0; i--) {
    const code = points[i].codePointAt(0)!
    if (code === 0x10ffff) continue
    // Skip UTF-16 surrogates when advancing the last Unicode scalar value.
    const next = code === 0xd7ff ? 0xe000 : code + 1
    const end = points.slice(0, i).join("") + String.fromCodePoint(next)
    return {
      sql: "SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key",
      params: [prefix, end],
    }
  }
  // Empty prefixes select all keys; the highest scalar has no successor.
  return {
    sql: "SELECT key FROM kv WHERE key >= ? ORDER BY key",
    params: [prefix],
  }
}
