import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Keep the frontend URL and integration revision in sync with pdf-range.patch.
// Bump the revision whenever the viewer/bridge changes, so caches never mix.
export const PDF_VIEWER_PATH = "static/pdfjs/6.3.289-openlist4"
const ARCHIVE_URL =
  "https://github.com/mozilla/pdf.js/releases/download/v6.3.289/pdfjs-6.3.289-legacy-dist.zip"
const ARCHIVE_SHA256 =
  "51683fac4aff7dd31ed91e9ab735a2098a78d50899d1ec529aed6dc8aa19400d"
const scripts = path.dirname(fileURLToPath(import.meta.url))

export function patchPdfRangeFetch(source) {
  // Chromium can serialize same-URL Range requests behind its HTTP cache even
  // when the response is no-store. Bypass that cache on the range fetch itself;
  // keep the initial full reader and PDF.js's in-memory chunk cache unchanged.
  const before = `function fetchUrl(url, headers, withCredentials, abortController) {
  return fetch(url, {
    method: "GET",
    headers,
    signal: abortController.signal,
    mode: "cors",
    credentials: withCredentials ? "include" : "same-origin",
    redirect: "follow"
  });
}`
  if (source.split(before).length !== 2)
    throw new Error("Unexpected PDF.js range fetch code")
  const after = before.replace(
    '    method: "GET",',
    '    ...(headers.has("Range") ? { cache: "no-store" } : {}),\n    method: "GET",',
  )
  return (
    "/* OpenList customization: bypass browser HTTP cache for PDF ranges. */\n" +
    source.replace(before, after)
  )
}

export function patchPdfPageTree(source) {
  // PDF.js validates the last page before resolving document loading. In a
  // nested /Pages node, the original walk fetches every preceding leaf in
  // sequence. Prefetch those required dictionaries as it already does at the
  // root; keep first-page/arbitrary-page reads lazy and preserve validation.
  const before = `if (currentNode === this.toplevelPagesDict && lastKid instanceof Ref && !pageDictCache.has(lastKid)) {
          pageDictCache.put(lastKid, xref.fetchAsync(lastKid));
        }`
  const after = `if ((currentNode === this.toplevelPagesDict || (Number.isInteger(count) && count > 0 && currentPageIndex + count === pageIndex + 1)) && lastKid instanceof Ref && !pageDictCache.has(lastKid)) {
          const pagePromise = xref.fetchAsync(lastKid);
          // Navigation or a malformed sibling can stop the walk before await.
          // Retain rejection for the actual reader without an unhandled promise.
          pagePromise.catch(() => {});
          pageDictCache.put(lastKid, pagePromise);
        }`
  if (source.split(before).length !== 2)
    throw new Error("Unexpected PDF.js page-tree prefetch code")
  return (
    "/* OpenList customization: parallelize required nested page-tree reads. */\n" +
    source.replace(before, after)
  )
}

export function installPdfViewer(dist, archive) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-pdfjs-"))
  try {
    const zip = archive || path.join(temp, "pdfjs.zip")
    if (!archive)
      execFileSync("curl", ["-fL", "--retry", "3", "-o", zip, ARCHIVE_URL], {
        stdio: "inherit",
      })
    const digest = createHash("sha256")
      .update(fs.readFileSync(zip))
      .digest("hex")
    if (digest !== ARCHIVE_SHA256)
      throw new Error("PDF.js release checksum mismatch")
    const extracted = path.join(temp, "release")
    execFileSync("unzip", ["-q", zip, "-d", extracted])
    const worker = path.join(extracted, "build/pdf.worker.mjs")
    fs.writeFileSync(worker, patchPdfPageTree(fs.readFileSync(worker, "utf8")))
    const api = path.join(extracted, "build/pdf.mjs")
    fs.writeFileSync(api, patchPdfRangeFetch(fs.readFileSync(api, "utf8")))
    const entry = path.join(extracted, "web/viewer.html")
    const html = fs.readFileSync(entry, "utf8")
    if (!html.includes('<script src="viewer.mjs" type="module"></script>'))
      throw new Error("Unexpected PDF.js viewer entry")
    fs.writeFileSync(
      entry,
      html
        .replace("<html ", '<html data-openlist-pdf-viewer="range" ')
        .replace(
          '<script src="viewer.mjs" type="module"></script>',
          '<script src="openlist.mjs" type="module"></script>',
        ),
    )
    fs.copyFileSync(
      path.join(scripts, "pdf-viewer-bridge.mjs"),
      path.join(extracted, "web/openlist.mjs"),
    )
    fs.copyFileSync(
      path.join(scripts, "pdf-print-preparation.mjs"),
      path.join(extracted, "web/openlist-print.mjs"),
    )
    // Retain LICENSE, fonts, CMaps, WASM and locales. Demo PDFs/maps aren't used.
    function prune(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) prune(full)
        else if (entry.name.endsWith(".map") || entry.name.endsWith(".pdf"))
          fs.rmSync(full)
      }
    }
    prune(extracted)
    const target = path.join(dist, PDF_VIEWER_PATH)
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(extracted, target, { recursive: true })
    console.log(`  PDF.js range viewer ready: ${PDF_VIEWER_PATH}`)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
