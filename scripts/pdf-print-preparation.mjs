// Page numbers always refer to the original document; duplicate/overlapping
// ranges print once, in document order. Validate before starting any PDF reads.
export function parsePrintPages(value, total) {
  if (!Number.isSafeInteger(total) || total < 1 || typeof value !== "string")
    throw new RangeError("Invalid print range")
  const pages = new Set()
  for (const part of value
    .replace(/[，、]/g, ",")
    .replace(/[–—]/g, "-")
    .split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part)
    if (!match) throw new RangeError("Invalid print range")
    const first = Number(match[1]),
      last = Number(match[2] || match[1])
    if (
      !Number.isSafeInteger(first) ||
      first < 1 ||
      last < first ||
      last > total
    )
      throw new RangeError("Invalid print range")
    for (let page = first; page <= last; page++) pages.add(page)
  }
  return [...pages].sort((a, b) => a - b)
}

function encodePrintPages(pages) {
  const ranges = []
  for (let i = 0; i < pages.length; i++) {
    const first = pages[i]
    while (pages[i + 1] === pages[i] + 1) i++
    ranges.push(first === pages[i] ? `${first}` : `${first}-${pages[i]}`)
  }
  return ranges.join(",")
}

export function installPdfPrintPreparation(
  app,
  win = window,
  { retryPages } = {},
) {
  const originalPrint = win.print
  const chinese = new URLSearchParams(win.location.search)
    .get("locale")
    ?.startsWith("zh")
  const text = chinese
    ? {
        select: "打印页面",
        title: "正在准备打印",
        all: "全部页面",
        current: "当前页面",
        range: "指定范围",
        placeholder: "例如：1-5,8,10-12",
        print: "打印",
        cancel: "取消",
        close: "关闭",
        retry: "重试",
        total: (total) => `共 ${total} 页`,
        hint: "使用原文档页码，只准备所选页面。后续系统打印窗口保持“全部”即可。",
        invalid: (total) => `请输入 1–${total} 内的页码或范围，例如 1-5,8。`,
        pages: (done, total) => `正在准备页面：${done} / ${total}`,
        error: "打印数据加载失败，请检查网络后重试。",
        changes: " 重试会重新加载文档，未保存的修改会丢失。",
      }
    : {
        select: "Print pages",
        title: "Preparing document for printing",
        all: "All pages",
        current: "Current page",
        range: "Page range",
        placeholder: "Example: 1-5,8,10-12",
        print: "Print",
        cancel: "Cancel",
        close: "Close",
        retry: "Retry",
        total: (total) => `${total} pages`,
        hint: "Use original document page numbers. Only selected pages are prepared; keep “All” in the system print dialog.",
        invalid: (total) =>
          `Enter pages or ranges within 1–${total}, e.g. 1-5,8.`,
        pages: (done, total) => `Preparing pages: ${done} / ${total}`,
        error: "Unable to load print data. Check your connection and retry.",
        changes: " Retrying reloads the document and discards unsaved changes.",
      }
  let current,
    printing,
    renderFailure,
    disposed = false

  function close(job = current) {
    if (!job) return
    job.cancelled = true
    if (current === job) current = undefined
    job.dialog.close()
    job.dialog.remove()
  }
  function active(job) {
    return (
      !disposed &&
      current === job &&
      !job.cancelled &&
      app.pdfDocument === job.document &&
      app.pdfViewer === job.viewer
    )
  }
  function clearPrinting() {
    if (printing) delete printing.viewer.openListPrintPages
    printing = undefined
  }
  function createJob(document) {
    const total = document.numPages,
      dialog = win.document.createElement("dialog")
    dialog.dataset.openlistPrint = "select"
    dialog.setAttribute("aria-label", text.select)
    dialog.style.cssText =
      "width:min(390px,80vw);max-width:85vw;box-sizing:border-box"
    // Reuse viewer.css classes; its CSP prohibits inline HTML styles.
    dialog.innerHTML = `<form>
      <div class="row"><strong data-title>${text.select}</strong></div>
      <div class="row"><span role="status" aria-live="polite">${text.total(total)}</span></div>
      <fieldset data-selection>
        <legend>${text.select}</legend>
        <label><input type="radio" name="pages" value="all" checked> ${text.all}</label>
        <label><input type="radio" name="pages" value="current"> ${text.current} (${app.pdfViewer.currentPageNumber})</label>
        <label><input type="radio" name="pages" value="range"> ${text.range}</label>
        <input type="text" class="toolbarField" data-range aria-label="${text.range}" placeholder="${text.placeholder}" maxlength="2000" autocomplete="off" aria-describedby="openlist-print-hint openlist-print-error">
        <small id="openlist-print-hint">${text.hint}</small>
      </fieldset>
      <div class="row"><span id="openlist-print-error" role="alert" hidden></span></div>
      <div class="row"><progress value="0" max="1" hidden></progress></div>
      <div class="buttonRow">
        <button type="button" class="secondaryButton" data-retry hidden>${text.retry}</button>
        <button type="button" class="secondaryButton" data-cancel>${text.cancel}</button>
        <button type="submit" class="primaryButton" data-submit autofocus>${text.print}</button>
      </div></form>`
    const job = {
      document,
      viewer: app.pdfViewer,
      dialog,
      status: dialog.querySelector('[role="status"]'),
      progress: dialog.querySelector("progress"),
      error: dialog.querySelector('[role="alert"]'),
      cancelled: false,
    }
    dialog.querySelector("fieldset").style.cssText =
      "display:grid;gap:12px;border:0;padding:4px 0;margin:0"
    dialog.querySelector("legend").hidden = true
    dialog.querySelector("small").style.cssText = "line-height:1.5;opacity:.8"
    dialog.querySelector("[data-range]").style.cssText =
      "width:100%;box-sizing:border-box;min-width:0"
    job.progress.style.width = "100%"
    const input = dialog.querySelector("[data-range]")
    input.oninput = () => {
      dialog.querySelector('[value="range"]').checked = true
      job.error.hidden = true
      input.removeAttribute("aria-invalid")
    }
    dialog.querySelector('[value="range"]').onchange = () => input.focus()
    dialog.querySelector("form").onsubmit = (event) => {
      event.preventDefault()
      if (!active(job) || job.dialog.dataset.openlistPrint !== "select") return
      const mode = dialog.querySelector('[name="pages"]:checked').value
      try {
        const pages =
          mode === "all"
            ? Array.from({ length: total }, (_, i) => i + 1)
            : mode === "current"
              ? [job.viewer.currentPageNumber]
              : parsePrintPages(input.value, total)
        start(job, pages)
      } catch {
        job.error.textContent = text.invalid(total)
        job.error.hidden = false
        input.setAttribute("aria-invalid", "true")
        input.focus()
      }
    }
    dialog.querySelector("[data-cancel]").onclick = () => close(job)
    dialog.querySelector("[data-retry]").onclick = () => retry(job)
    dialog.addEventListener("close", () => close(job), { once: true })
    win.document.body.append(dialog)
    current = job
    dialog.showModal()
    return job
  }
  function start(job, pages) {
    job.pages = pages
    job.dialog.dataset.openlistPrint = "loading"
    job.dialog.setAttribute("aria-label", text.title)
    job.dialog.querySelector("[data-title]").textContent = text.title
    job.dialog.querySelector("[data-selection]").hidden = true
    // An explicit display style must be removed for the hidden attribute to win.
    job.dialog.querySelector("[data-selection]").style.display = "none"
    job.dialog.querySelector("[data-submit]").hidden = true
    job.error.hidden = true
    job.progress.hidden = false
    job.progress.max = pages.length
    job.status.textContent = text.pages(0, pages.length)
    job.dialog.querySelector("[data-cancel]").focus()
    job.promise = prepare(job)
  }
  function showFailure(document, pages) {
    if (disposed || app.pdfDocument !== document) return
    close()
    const job = createJob(document)
    job.pages = pages
    job.cancelled = true
    job.dialog.dataset.openlistPrint = "error"
    job.dialog.querySelector("[data-title]").textContent = text.title
    job.dialog.querySelector("[data-selection]").style.display = "none"
    job.dialog.querySelector("[data-submit]").hidden = true
    job.status.setAttribute("role", "alert")
    job.status.textContent =
      text.error + (app._hasChanges?.() ? text.changes : "")
    job.dialog.querySelector("[data-retry]").hidden = false
    job.dialog.querySelector("[data-cancel]").textContent = text.close
    job.dialog.querySelector("[data-retry]").focus()
  }
  function retry(job) {
    if (disposed || current !== job) return
    // Fresh iframe avoids failed PDF.js readers/caches. Persist only page numbers
    // in the one-shot URL; the parent supplies the signed file URL via handshake.
    const url = new URL(win.location.href)
    url.searchParams.set("openlistPrint", "1")
    url.searchParams.set("openlistPrintPages", encodePrintPages(job.pages))
    close(job)
    win.location.replace(url.href)
  }
  async function prepare(job) {
    try {
      await job.viewer.pagesPromise
      let next = 0,
        done = 0
      await Promise.all(
        Array.from({ length: Math.min(4, job.pages.length) }, async () => {
          while (active(job)) {
            const index = next++
            if (index >= job.pages.length) return
            const number = job.pages[index],
              view = job.viewer.getPageView(number - 1)
            if (!view?.pdfPage) {
              const page = await job.document.getPage(number)
              if (!active(job)) return
              view.setPdfPage(page)
            }
            if (!active(job)) return
            job.progress.value = ++done
            job.status.textContent = text.pages(done, job.pages.length)
          }
        }),
      )
      if (!active(job)) return
      if (
        !job.pages.every(
          (number) => job.viewer.getPageView(number - 1)?.pdfPage,
        )
      )
        throw new Error("Print pages not ready")
      close(job)
      printing = job
      job.viewer.openListPrintPages = job.pages
      try {
        originalPrint.call(win)
      } catch {
        clearPrinting()
        showFailure(job.document, job.pages)
      }
    } catch {
      if (active(job)) showFailure(job.document, job.pages)
    }
  }
  const print = () => {
    if (disposed || app.printService) return
    if (current && !current.cancelled) return
    if (current?.dialog.dataset.openlistPrint === "error") return retry(current)
    close()
    const document = app.pdfDocument,
      viewer = app.pdfViewer
    if (
      !document ||
      !viewer ||
      !app.supportsPrinting ||
      !viewer.printingAllowed
    )
      return originalPrint.call(win)
    const job = createJob(document)
    if (retryPages) {
      const value = retryPages
      retryPages = undefined
      try {
        start(job, parsePrintPages(value, document.numPages))
      } catch {
        /* Invalid retry state falls back to choosing pages. */
      }
    }
  }
  const beforePrint = () => {
    const service = app.printService,
      job = printing
    if (!service || !job) return
    const renderPages = service.renderPages
    service.renderPages = async function () {
      try {
        return await renderPages.call(this)
      } catch (error) {
        if (app.printService === service && app.pdfDocument === job.document)
          renderFailure = job
        throw error
      }
    }
  }
  const afterPrint = () => {
    const job = renderFailure
    renderFailure = undefined
    clearPrinting()
    if (job) showFailure(job.document, job.pages)
  }
  const pagesDestroyed = () => {
    renderFailure = undefined
    clearPrinting()
    close()
  }
  win.print = print
  app.eventBus.on("beforeprint", beforePrint)
  app.eventBus.on("afterprint", afterPrint)
  app.eventBus.on("pagesdestroy", pagesDestroyed)
  return () => {
    disposed = true
    pagesDestroyed()
    if (win.print === print) win.print = originalPrint
    app.eventBus.off("beforeprint", beforePrint)
    app.eventBus.off("afterprint", afterPrint)
    app.eventBus.off("pagesdestroy", pagesDestroyed)
  }
}
