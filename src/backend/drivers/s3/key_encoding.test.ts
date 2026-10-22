import assert from "node:assert/strict"
import { test } from "node:test"
import { S3Client } from "./util"

const client = (extra: Record<string, unknown> = {}) =>
  new S3Client({
    bucket: "bk",
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    region: "us-west-004",
    access_key_id: "id",
    secret_access_key: "secret",
    ...extra,
  } as any)

const decodedPath = (url: string) =>
  new URL(url).pathname.split("/").map(decodeURIComponent).join("/")

test("object keys keep literal % and other reserved characters", () => {
  const c = client()
  for (const name of [
    "a%41.txt",
    "50% off.jpg",
    "x+y (1).txt",
    "中文 #1?.mp4",
    "it's*.txt",
  ]) {
    const url = c.getUrl(`dir/${name}`)
    assert.equal(decodedPath(url), `/dir/${name}`, url)
  }
})

test("uploads write the exact key even when the name looks percent-encoded", async (t) => {
  const seen: string[] = []
  t.mock.method(globalThis, "fetch", async (input: any) => {
    seen.push(String(input))
    return new Response("")
  })
  await client().putObject("dir/a%41.txt", new Uint8Array(1))
  assert.equal(decodedPath(seen[0]), "/dir/a%41.txt")
})

test("unsigned custom-host links encode #, ? and % instead of truncating", async () => {
  const { url } = await client().getLink(
    "视频/第1集 #1?50%.mp4",
    "x",
    4,
    "https://cdn.example.com",
  )
  const parsed = new URL(url)
  assert.equal(parsed.hash, "")
  assert.equal(parsed.search, "")
  assert.equal(decodedPath(url), "/视频/第1集 #1?50%.mp4")
  // Must be usable as a Location header (ASCII only).
  assert.doesNotThrow(() => new Headers({ Location: url }))
})

test("presigned links sign the same path that is requested", async () => {
  const { url } = await client().getLink("dir/50% (1).mp4", "x")
  const parsed = new URL(url)
  assert.equal(decodedPath(url), "/dir/50% (1).mp4")
  assert.ok(parsed.searchParams.get("X-Amz-Signature"))
  assert.match(parsed.pathname, /50%25%20%281%29\.mp4$/)
})
