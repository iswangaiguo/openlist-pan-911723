// Serve HTML routes and asset failures separately. A missing hashed module must
// never receive the SPA shell, and every HTML entry must revalidate after deploy.
import { cdnAssetRedirect, getIndexHtmlWithCdn, isCdnConfigured } from "./assets"

export async function serveFrontend(request: Request, assets?: { fetch(request: Request): Promise<Response> }, inlineHtml?: string | null, env?: any): Promise<Response> {
  const url = new URL(request.url)
  const asset = /^\/(assets|images|streamer|static)(\/|$)/.test(url.pathname)
  const html = (response: Response) => /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get("content-type") || "")
  const cache = (response: Response, policy: string) => {
    const headers = new Headers(response.headers)
    headers.set("Cache-Control", policy)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
  const prepareHtml = async (response: Response) => {
    const cached = cache(response, "no-cache, must-revalidate")
    if (!response.ok || !["GET", "HEAD"].includes(request.method) || !isCdnConfigured(env)) return cached
    const headers = new Headers(cached.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")
    let body = await cached.text()
    try {
      body = await getIndexHtmlWithCdn(env, body)
    } catch {
      // CDN failures must leave the local frontend usable.
    }
    return new Response(request.method === "HEAD" ? null : body, { status: cached.status, statusText: cached.statusText, headers })
  }
  const redirectAsset = async () => {
    const location = await cdnAssetRedirect(env, url.pathname + url.search)
    return location ? new Response(null, { status: 302, headers: { Location: location } }) : null
  }
  if (assets) {
    const response = await assets.fetch(request)
    if (asset) {
      if (!response.ok || html(response)) {
        const redirect = await redirectAsset()
        if (redirect) return redirect
      }
      if (html(response) && response.ok) return new Response(request.method === "HEAD" ? null : "Asset not found", { status: 404, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } })
      return response.status >= 400 ? cache(response, "no-store") : response
    }
    if (response.status === 304) return cache(response, "no-cache, must-revalidate")
    if (response.ok) return html(response) ? prepareHtml(response) : response
    const fallback = await assets.fetch(new Request(url.origin + "/", request))
    return html(fallback) ? prepareHtml(fallback) : fallback
  }
  if (asset) {
    const redirect = await redirectAsset()
    if (redirect) return redirect
  }
  if (!asset && inlineHtml && ["GET", "HEAD"].includes(request.method)) return prepareHtml(new Response(inlineHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
  return new Response(request.method === "HEAD" ? null : "404 Not Found", { status: 404, headers: { "Cache-Control": "no-store" } })
}
