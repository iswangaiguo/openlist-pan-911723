import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { test } from "node:test"

// Execute the real deployed worker's method, rather than a second copy of the
// traversal. The harness delays xref reads so concurrency and lazy reads matter.
const directory = process.env.PDF_VIEWER_DIR
if (!directory)
  throw new Error("Set PDF_VIEWER_DIR to the installed PDF.js directory")
const worker = fs.readFileSync(
  path.join(directory, "build/pdf.worker.mjs"),
  "utf8",
)
const start = worker.indexOf("  async getPageDict(pageIndex) {")
const end = worker.indexOf("  async getAllPageDicts(", start)
assert.ok(
  start >= 0 && end > start,
  "PDF.js page-tree method must be recognized",
)
const method = worker.slice(start, end)

class Ref {
  constructor(num) {
    this.num = num
  }
  toString() {
    return `${this.num}R`
  }
}
class RefSet extends Set {
  put(ref) {
    this.add(String(ref))
  }
  has(ref) {
    return super.has(String(ref))
  }
}
class Dict {
  constructor(values, ref) {
    this.values = values
    this.objId = ref?.toString()
  }
  getRaw(key) {
    return this.values[key]
  }
  get(key) {
    return this.getRaw(key)
  }
  has(key) {
    return key in this.values
  }
}
class Cache {
  data = new Map()
  get(key) {
    return this.data.get(String(key))
  }
  has(key) {
    return this.data.has(String(key))
  }
  put(key, value) {
    this.data.set(String(key), value)
  }
}
class FormatError extends Error {}
const Catalog = vm.runInNewContext(
  `(class Catalog {
  #catDict;
  constructor(root, xref, ref) {
    this.toplevelPagesDict = root;
    this.#catDict = new Dict({ Pages: ref });
    this.xref = xref;
    this.pageKidsCountCache = new Cache();
    this.pageIndexCache = new Cache();
    this.pageDictCache = new Cache();
  }
  ${method}
})`,
  {
    Dict,
    Ref,
    RefSet,
    Cache,
    FormatError,
    isName: (name, value) => name === value,
  },
)

function harness({ count = 8, invalid = false, flat = false } = {}) {
  const rootRef = new Ref(1),
    branchRef = new Ref(2)
  const leaves = Array.from({ length: 8 }, (_, i) => new Ref(i + 3))
  const dicts = new Map(
    leaves.map((ref) => [ref, new Dict({ Type: "Page" }, ref)]),
  )
  const branch = new Dict(
    { Type: "Pages", Count: count, Kids: leaves },
    branchRef,
  )
  const root = new Dict(
    { Type: "Pages", Count: 8, Kids: flat ? leaves : [branchRef] },
    rootRef,
  )
  dicts.set(branchRef, branch)
  const reads = []
  let active = 0,
    peak = 0
  const xref = {
    fetchAsync: async (ref) => {
      reads.push(ref)
      peak = Math.max(peak, ++active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      if (invalid && [leaves[0], leaves[7]].includes(ref))
        throw new FormatError("invalid page reference")
      return dicts.get(ref)
    },
  }
  return {
    catalog: new Catalog(root, xref, rootRef),
    leaves,
    branchRef,
    reads,
    peak: () => peak,
  }
}

test("nested last-page validation fetches the same required dictionaries concurrently", async () => {
  const h = harness()
  const [dict, ref] = await h.catalog.getPageDict(7)
  assert.equal(ref, h.leaves[7])
  assert.equal(dict.get("Type"), "Page")
  assert.equal(h.peak(), 8)
  assert.deepEqual(new Set(h.reads), new Set([h.branchRef, ...h.leaves]))
  assert.equal(h.reads.length, 9)
})
test("reading the first or an arbitrary page keeps unnecessary siblings lazy", async () => {
  for (const page of [0, 3]) {
    const h = harness()
    const [, ref] = await h.catalog.getPageDict(page)
    assert.equal(ref, h.leaves[page])
    assert.equal(h.peak(), 1)
    assert.equal(h.reads.length, page + 2)
    assert.ok(h.leaves.slice(page + 1).every((leaf) => !h.reads.includes(leaf)))
  }
})
test("the original root prefetch and cached dictionary reuse remain intact", async () => {
  const h = harness({ flat: true })
  assert.equal((await h.catalog.getPageDict(7))[1], h.leaves[7])
  assert.equal(h.peak(), 8)
  assert.equal(h.reads.length, 8)
  assert.equal((await h.catalog.getPageDict(0))[1], h.leaves[0])
  assert.equal(h.reads.length, 8)
})
test("invalid or unknown nested counts keep the original validated traversal", async () => {
  for (const count of [null, "8", -1, 0, 7.5]) {
    const h = harness({ count })
    if (count === 0) await assert.rejects(h.catalog.getPageDict(7), /not found/)
    else {
      assert.equal((await h.catalog.getPageDict(7))[1], h.leaves[7])
      assert.equal(h.peak(), 1)
    }
  }
})
test("malformed prefetched siblings preserve reader errors without unhandled rejections", async () => {
  const h = harness({ invalid: true })
  await assert.rejects(h.catalog.getPageDict(7), /invalid page reference/)
  // Let an unawaited later sibling also reject; node:test detects an unhandled
  // rejection even though the traversal already exited at the first sibling.
  await new Promise((resolve) => setTimeout(resolve, 15))
})
test("circular page-tree references still fail validation", async () => {
  const h = harness()
  h.catalog.toplevelPagesDict.values.Kids = [new Ref(1)]
  await assert.rejects(h.catalog.getPageDict(0), /circular reference/)
})
