import assert from "node:assert/strict"
import { test } from "node:test"
import { parsePrintPages } from "../pdf-print-preparation.mjs"
import { patchPdfPrintRange } from "../fetch-pdf-viewer.mjs"

test("print ranges use original page numbers, deduplicate and preserve document order", () => {
  assert.deepEqual(
    parsePrintPages("9, 5-7,7，1、3–4", 12),
    [1, 3, 4, 5, 6, 7, 9],
  )
  assert.deepEqual(parsePrintPages("12", 12), [12])
  assert.deepEqual(parsePrintPages("1-1", 1), [1])
})

test("empty, reversed, malformed and out-of-bounds ranges never start a print job", () => {
  for (const value of [
    "",
    " ",
    "0",
    "-1",
    "13",
    "1-13",
    "8-3",
    "1,,2",
    "2.5",
    "1-",
    "1/2",
    "1e2",
    "9007199254740992",
    "<script>",
  ])
    assert.throws(() => parsePrintPages(value, 12), RangeError, value)
  assert.throws(() => parsePrintPages("1", 0), RangeError)
})

test("changed upstream print code fails the build rather than silently printing the wrong pages", () => {
  assert.throws(
    () => patchPdfPrintRange("unrecognized viewer"),
    /Unexpected PDF.js print range/,
  )
  const guard = "if (!this.pdfViewer.pageViewsReady) {"
  assert.throws(
    () => patchPdfPrintRange(guard + guard),
    /Unexpected PDF.js print range/,
  )
})
