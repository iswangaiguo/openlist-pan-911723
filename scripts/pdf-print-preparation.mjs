// The generic viewer requires initialized page views before its synchronous
// beforeprint event. Keep preview lazy; initialize missing views only on print.
export function installPdfPrintPreparation(app, win = window) {
  const originalPrint = win.print
  const chinese = new URLSearchParams(win.location.search)
    .get("locale")
    ?.startsWith("zh")
  const text = chinese
    ? {
        title: "正在准备打印",
        pages: (done, total) => `正在准备页面：${done} / ${total}`,
        error: "打印数据加载失败，请检查网络后重试。",
        cancel: "取消",
        close: "关闭",
        retry: "重试",
      }
    : {
        title: "Preparing document for printing",
        pages: (done, total) => `Preparing pages: ${done} / ${total}`,
        error: "Unable to load print data. Check your connection and retry.",
        cancel: "Cancel",
        close: "Close",
        retry: "Retry",
      }
  let current,
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
  function createJob(document) {
    const total = document?.numPages || 0
    const dialog = win.document.createElement("dialog")
    dialog.dataset.openlistPrint = "loading"
    dialog.setAttribute("aria-label", text.title)
    dialog.style.cssText = "min-width:min(340px,75vw);max-width:85vw"
    // Reuse viewer.css classes: its CSP does not allow inline HTML styles.
    dialog.innerHTML = `<div class="row"><span>${text.title}</span></div>
      <div class="row"><span role="status" aria-live="polite"></span></div>
      <div class="row"><progress value="0" max="${total || 1}"></progress></div>
      <div class="buttonRow">
        <button type="button" class="secondaryButton" data-retry hidden>${text.retry}</button>
        <button type="button" class="secondaryButton" data-cancel autofocus>${text.cancel}</button>
      </div>`
    const job = {
      document,
      viewer: app.pdfViewer,
      dialog,
      status: dialog.querySelector('[role="status"]'),
      progress: dialog.querySelector("progress"),
      cancelled: false,
    }
    job.status.textContent = text.pages(0, total)
    job.progress.style.width = "100%"
    dialog.querySelector("[data-cancel]").onclick = () => close(job)
    dialog.querySelector("[data-retry]").onclick = () => retry(job)
    dialog.addEventListener("close", () => close(job), { once: true })
    win.document.body.append(dialog)
    current = job
    dialog.showModal()
    return job
  }
  function showFailure(document) {
    if (disposed || app.pdfDocument !== document) return
    close()
    const job = createJob(document)
    job.cancelled = true // Stop workers from the failed attempt.
    job.dialog.dataset.openlistPrint = "error"
    job.status.setAttribute("role", "alert")
    job.status.textContent = text.error
    if (app._hasChanges?.())
      job.status.textContent += chinese
        ? " 重试会重新加载文档，未保存的修改会丢失。"
        : " Retrying reloads the document and discards unsaved changes."
    job.progress.hidden = true
    job.dialog.querySelector("[data-retry]").hidden = false
    job.dialog.querySelector("[data-cancel]").textContent = text.close
    job.dialog.querySelector("[data-retry]").focus()
  }
  function retry(job) {
    if (disposed || current !== job) return
    // A fresh iframe releases failed worker caches and active readers without
    // waiting on PDF.js document destruction during an outstanding read. The
    // same-origin parent supplies the signed URL again via the normal handshake.
    // Only a one-shot print flag goes into the viewer URL, never the file URL.
    const url = new URL(win.location.href)
    url.searchParams.set("openlistPrint", "1")
    close(job)
    win.location.replace(url.href)
  }
  async function prepare(job) {
    try {
      // This resolves after initial page-view setup, including in lazy mode.
      await job.viewer.pagesPromise
      let next = 0,
        done = 0
      // Bound outstanding reads so cancelling stops new work promptly. Reads
      // already in PDF.js may finish and remain cached for a later retry.
      await Promise.all(
        Array.from({ length: Math.min(4, job.document.numPages) }, async () => {
          while (active(job)) {
            const index = next++
            if (index >= job.document.numPages) return
            const view = job.viewer.getPageView(index)
            if (!view?.pdfPage) {
              const page = await job.document.getPage(index + 1)
              if (!active(job)) return
              view.setPdfPage(page)
            }
            if (!active(job)) return
            job.progress.value = ++done
            job.status.textContent = text.pages(done, job.document.numPages)
          }
        }),
      )
      if (!active(job)) return
      if (!job.viewer.pageViewsReady) throw new Error("Print pages not ready")
      close(job)
      // PDF.js now renders all print pages with its existing progress/cancel UI.
      try {
        originalPrint.call(win)
      } catch {
        showFailure(job.document)
      }
    } catch {
      if (active(job)) showFailure(job.document)
    }
  }
  const print = () => {
    if (disposed || app.printService) return
    if (current && !current.cancelled) return current.promise
    if (current?.dialog.dataset.openlistPrint === "error") return retry(current)
    close()
    const document = app.pdfDocument,
      viewer = app.pdfViewer
    if (
      !document ||
      !viewer ||
      !app.supportsPrinting ||
      !viewer.printingAllowed ||
      (viewer.pagesCount > 0 && viewer.pageViewsReady)
    )
      return originalPrint.call(win)
    const job = createJob(document)
    job.promise = prepare(job)
    return job.promise
  }
  // The generic print service otherwise swallows render/network failures.
  // Surface a retry after its own afterprint cleanup, excluding user cancels.
  const beforePrint = () => {
    const service = app.printService,
      document = app.pdfDocument
    if (!service) return
    const renderPages = service.renderPages
    service.renderPages = async function () {
      try {
        return await renderPages.call(this)
      } catch (error) {
        if (app.printService === service && app.pdfDocument === document)
          renderFailure = document
        throw error
      }
    }
  }
  const afterPrint = () => {
    const document = renderFailure
    renderFailure = undefined
    if (document) showFailure(document)
  }
  const pagesDestroyed = () => {
    renderFailure = undefined
    close()
  }
  win.print = print
  app.eventBus.on("beforeprint", beforePrint)
  app.eventBus.on("afterprint", afterPrint)
  app.eventBus.on("pagesdestroy", pagesDestroyed)
  return () => {
    disposed = true
    close()
    if (win.print === print) win.print = originalPrint
    app.eventBus.off("beforeprint", beforePrint)
    app.eventBus.off("afterprint", afterPrint)
    app.eventBus.off("pagesdestroy", pagesDestroyed)
  }
}
