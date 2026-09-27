// Serve HTML routes and asset failures separately. A missing hashed module must
// never receive the SPA shell, and every HTML entry must revalidate after deploy.
export async function serveFrontend(request: Request, assets?: { fetch(request: Request): Promise<Response> }, inlineHtml?: string | null): Promise<Response> {
  const url = new URL(request.url)
  const asset = /^\/(assets|images|streamer|static)(\/|$)/.test(url.pathname)
  const html = (response: Response) => /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get("content-type") || "")
  const cache = (response: Response, policy: string) => {
    const headers = new Headers(response.headers)
    headers.set("Cache-Control", policy)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
  if (assets) {
    const response = await assets.fetch(request)
    if (asset) {
      if (html(response) && response.ok) return new Response(request.method === "HEAD" ? null : "Asset not found", { status: 404, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } })
      return response.status >= 400 ? cache(response, "no-store") : response
    }
    if (response.status === 304) return cache(response, "no-cache, must-revalidate")
    if (response.ok) return html(response) ? cache(response, "no-cache, must-revalidate") : response
    const fallback = await assets.fetch(new Request(url.origin + "/", request))
    return html(fallback) ? cache(fallback, "no-cache, must-revalidate") : fallback
  }
  if (!asset && inlineHtml && ["GET", "HEAD"].includes(request.method)) return new Response(request.method === "HEAD" ? null : inlineHtml, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" } })
  return new Response(request.method === "HEAD" ? null : "404 Not Found", { status: 404, headers: { "Cache-Control": "no-store" } })
}
