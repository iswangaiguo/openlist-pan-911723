// Opt-in pilot only. The matching zone Cache Rule must enable Origin Range
// Requests and ignore query strings on this exact B2 object, never on /api/p.
export const sameEtag = (a: unknown, b: unknown): boolean => {
  const normalize = (value: unknown) =>
    typeof value === "string" ? value.replace(/^"|"$/g, "") : ""
  return !!normalize(a) && normalize(a) === normalize(b)
}

export function b2RangeCachePolicy(
  url: string,
  headers: Record<string, string>,
  isVideo: boolean,
  context?: { config: unknown; etag: unknown; size: unknown },
): { target: boolean; enabled: boolean } {
  const off = { target: false, enabled: false }
  try {
    if (typeof context?.config !== "string") return off
    const config = JSON.parse(context.config)
    const pinned = new URL(config.url)
    const current = new URL(url)
    if (
      pinned.protocol !== "https:" ||
      !pinned.hostname.endsWith(".backblazeb2.com") ||
      pinned.search ||
      pinned.hash ||
      pinned.username ||
      pinned.password ||
      current.origin !== pinned.origin ||
      current.pathname !== pinned.pathname
    )
      return off
    const range = new Headers(headers).get("range") || ""
    return {
      target: true,
      enabled:
        isVideo &&
        /^bytes=(?:\d+-\d*|-\d+)$/.test(range) &&
        Number.isSafeInteger(config.size) &&
        config.size > 0 &&
        config.size <= 512 * 1024 * 1024 &&
        Number(context.size) === config.size &&
        sameEtag(context.etag, config.etag),
    }
  } catch {
    return off
  }
}
