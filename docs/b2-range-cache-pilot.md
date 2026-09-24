# B2 origin range cache pilot

This opt-in pilot caches one pinned private B2 video after OpenList download authentication. Other B2 video ranges continue using `no-store`; signed HEAD metadata requests always bypass cache.

Set the Worker variable `B2_RANGE_CACHE_PILOT` to JSON containing `url` (the HTTPS B2 object URL without query parameters), `etag` (from HEAD), and `size` (bytes). The object must fit Cloudflare's 512 MiB cache limit. Deployment preserves dashboard variables with `keep_vars`.

In the zone's Cache Rules, match only that exact B2 hostname and encoded object path, with method GET. Enable **Eligible for cache**, **Origin range requests: On**, and **Cache key: Ignore query string**. This applies to the outbound Worker fetch, not the public OpenList route. Never apply the query-string rule to `/api/p` or enable a cache in front of download authentication.

The Worker retains the S3 signature in the actual origin URL. Only the cache identity ignores its changing query. Successful origin responses are eligible for seven days; errors are not stored. A fresh HEAD must match the pinned ETag and size. If the file changes, requests bypass cached bytes. The GET response ETag is checked too. Browser responses use `private, no-store`, so each new public request passes authentication. Origin credentials and object-specific configuration are not in this repository.

`X-OpenList-Range-Cache` reports the upstream result and `X-OpenList-Origin-Ms` measures the GET header wait, excluding OpenList/database/HEAD and client network time. These are diagnostics, not end-to-end playback measurements.

## Validation and rollback

Tests cover auth (missing, invalid, expired), signed B2 fetches, unchanged HEAD bypass, partial-response bytes/headers, version changes, unsupported scopes, and stale cached ETags. In production, check disjoint byte intervals, repeated reads and a nearby interval inside the same 1 MiB origin chunk. Compare returned bytes with the source file and check unsigned access after a HIT.

To disable the pilot, remove `B2_RANGE_CACHE_PILOT` and disable its single-object Cache Rule. To change the pinned object version, disable the rule and purge its cache before updating the configuration and re-enabling. The pilot is deliberately limited to one immutable file; a general multi-file cache needs versioned cache identities.
