import assert from "node:assert/strict"
import { test } from "node:test"
import { createRequire } from "node:module"
import { build } from "esbuild"

// Resolve the same workerd runtime Wrangler uses, without adding a dependency.
const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"))
const { Miniflare } = wranglerRequire("miniflare")

test("native Worker stream enforces length, forwards bytes, and cancels provider failures", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import {pipePartBody} from './src/backend/internal/upload/multipart';
        export default {async fetch(request, env) {
          let seen = 0;
          try {
            const result = await pipePartBody(request, Number(new URL(request.url).searchParams.get('size')), async body => {
              if (new URL(request.url).pathname === '/reject') throw new Error('provider rejected');
              const outgoing = new Request('https://provider.test/part', {method:'PUT',body});
              const response = await env.PROVIDER.fetch(outgoing);
              if (!response.ok) throw new Error('provider rejected body');
              return response.json();
            });
            return Response.json(result);
          } catch(e) {return Response.json({error:e.message,seen},{status:400});}
        }};
      `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
  })
  const mf = new Miniflare({
    workers: [
      {
        name: "relay",
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-08-04",
        serviceBindings: { PROVIDER: "provider" },
      },
      {
        name: "provider",
        modules: true,
        compatibilityDate: "2026-08-04",
        script: `export default {async fetch(request) {
      try {const length=request.headers.get('content-length');const body=await request.arrayBuffer();return Response.json({length,seen:body.byteLength});}
      catch(e) {return new Response(e.message,{status:400});}
    }}`,
      },
    ],
  })
  try {
    const size = 10 * 1024 * 1024
    const ok = await mf.dispatchFetch(`https://test/part?size=${size}`, {
      method: "PUT",
      body: new Uint8Array(size),
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { length: String(size), seen: size })
    for (const actual of [9, 11]) {
      const bad = await mf.dispatchFetch("https://test/part?size=10", {
        method: "PUT",
        body: new Uint8Array(actual),
      })
      assert.equal(bad.status, 400)
      assert.ok((await bad.json()).error)
    }
    const rejected = await mf.dispatchFetch(
      `https://test/reject?size=${size}`,
      { method: "PUT", body: new Uint8Array(size) },
    )
    assert.equal(rejected.status, 400)
    assert.equal((await rejected.json()).error, "provider rejected")
  } finally {
    await mf.dispose()
  }
})
