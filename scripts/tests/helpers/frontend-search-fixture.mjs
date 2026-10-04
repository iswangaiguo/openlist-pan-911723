import fs from "node:fs"
import path from "node:path"
import http from "node:http"

export function createSearchFixture(dist) {
  const searches = []
  const folder = {
    parent: "/private.[1]",
    name: "Documents",
    is_dir: true,
    size: 0,
    type: 1,
  }
  const report = {
    parent: "/private.[1]/Documents",
    name: "report.pdf",
    is_dir: false,
    size: 2048,
    type: 4,
  }
  let slowFinished = Promise.resolve()
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost")
    if (url.pathname.startsWith("/api/")) {
      let data = {},
        code = 200
      if (url.pathname.endsWith("/public/init_status"))
        data = { initialized: true }
      else if (url.pathname.endsWith("/public/settings"))
        data = {
          backend: "ts-worker",
          site_title: "OpenList",
          version: "4.2.3",
          logo: "",
          main_color: "#0061ff",
          pagination_type: "all",
          search_index: "database",
          iframe_previews: "{}",
          external_previews: "{}",
        }
      else if (url.pathname.endsWith("/public/archive_extensions")) data = []
      else if (url.pathname.endsWith("/me"))
        data = {
          id: 1,
          username: "admin",
          role: 2,
          permission: 0,
          base_path: "/private.[1]",
          disabled: false,
          otp: false,
        }
      else if (url.pathname.endsWith("/fs/list"))
        data = {
          content: [
            {
              ...folder,
              modified: "2026-10-04T00:00:00Z",
              created: "2026-10-04T00:00:00Z",
            },
            {
              ...report,
              name: "original.pdf",
              modified: "2026-10-04T00:00:00Z",
              created: "2026-10-04T00:00:00Z",
            },
          ],
          total: 2,
          readme: "",
          header: "",
          write: true,
          provider: "S3",
        }
      else if (url.pathname.endsWith("/fs/get"))
        data = {
          ...folder,
          modified: "2026-10-04T00:00:00Z",
          created: "2026-10-04T00:00:00Z",
          thumb: "",
          sign: "",
          readme: "",
          header: "",
          provider: "S3",
          related: [],
          raw_url: "",
        }
      else if (url.pathname.endsWith("/fs/usage")) data = { mounts: [] }
      else if (url.pathname.endsWith("/fs/search")) {
        let body = ""
        for await (const chunk of req) body += chunk
        const search = JSON.parse(body)
        searches.push(search)
        if (search.keywords === "slow") {
          slowFinished = new Promise((resolve) => setTimeout(resolve, 1600))
          await slowFinished
        }
        if (search.keywords === "forbidden") code = 403
        if (search.keywords === "unauthorized") code = 401
        data = {
          total:
            search.keywords === "none"
              ? 0
              : search.keywords === "pages"
                ? 101
                : search.scope === 0
                  ? 2
                  : 1,
          content:
            search.keywords === "none"
              ? []
              : search.keywords === "pages"
                ? [{ ...report, name: `page-${search.page}.pdf` }]
                : search.keywords === "slow"
                  ? [{ ...report, name: "old-result.pdf" }]
                  : search.scope === 1
                    ? [folder]
                    : search.scope === 2
                      ? [report]
                      : [folder, report],
        }
      }
      res.setHeader("Content-Type", "application/json")
      res.end(
        JSON.stringify({
          code,
          message: code === 200 ? "success" : "permission denied",
          data,
        }),
      )
      return
    }
    let file = path.join(dist, url.pathname.replace("/__dynamic_base__/", "/"))
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      file = path.join(dist, "index.html")
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".json": "application/json",
      }[path.extname(file)] || "application/octet-stream",
    )
    res.end(fs.readFileSync(file))
  })
  return { server, searches, slowFinished: () => slowFinished }
}
