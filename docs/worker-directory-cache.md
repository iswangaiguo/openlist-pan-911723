# Shared Worker directory cache

The browser continues calling `/api/fs/list`. The Worker authenticates the caller,
checks directory policies, reads shared raw S3 directory metadata from D1, then
applies visibility filtering and generates fresh OpenList download signatures.
No whole API response, user permission, B2 presigned URL or credential is cached.
Browser-facing directory responses remain `private, no-store`.

## Configuration and behavior

- `DIRECTORY_CACHE_ENABLED=true` enables the cache for supported S3-compatible
  mounts with a D1 binding. Missing D1 or an unsupported driver bypasses caching.
- TTL is the smaller of the storage/path `cache_expiration` (minutes) and
  `DIRECTORY_CACHE_MAX_SECONDS` (default 300 seconds). A policy of 0 disables it.
- Shared D1 data survives Worker cold starts and is usable by other instances
  and Cloudflare locations. No additional cache service or binding is needed.
- Only raw metadata is cached. Virtual mount merging, permissions, hidden-file
  filtering, pagination and signed links are recomputed per request.
- An explicit `/api/fs/list` request with `refresh:true` invalidates the mount's
  cached listings and reads the origin. S3 metadata listing bypasses edge HTTP
  caching, so refresh does not accidentally read another stale cache.
- Worker-mediated upload, mkdir, rename, delete, move and copy invalidate the
  affected storage(s) before and after the operation, including partial failures.
  Shared revision checks prevent an old in-flight query from repopulating the cache
  after a mutation or refresh. Reads overlapping a write may see an intermediate
  state; successful write completion invalidates it again.
- Direct B2 console/S3 client changes and browser-to-B2 direct uploads cannot notify
  the Worker automatically. Use Refresh after completion; otherwise changes appear
  at expiry (at most 5 minutes with this deployment). Cross-mount aliases to the
  same physical bucket are also independent cache scopes.
- Existing short-lived configuration/auth memoization is unchanged; directory TTL
  does not extend permission or login validity.

## Limits and failure behavior

At most 256 directory entries, each at most 512 KiB UTF-8, are retained. Larger
listings bypass storage. Expired entries are removed on cache writes; this is not
an exact periodic cleanup schedule. Errors are never cached. Cache read/write
failures fall back to the provider. Mutation invalidation failures are surfaced:
a pre-invalidation failure stops the mutation; a post-invalidation failure reports
an error even if the provider already changed data, so check before retrying.
Within an instance, simultaneous misses for the same key and revision coalesce.
Across instances simultaneous cold misses may still each read B2.

`X-Openlist-Directory-Cache` exposes `HIT`, `MISS`, `REFRESH`, or `BYPASS` on normal
listing responses. This describes directory metadata, not video range caching.
Disable `DIRECTORY_CACHE_ENABLED` to roll back; no user data is changed or removed.

## Verification

Tests run actual SQLite statements through a D1-compatible fixture. Coverage
includes cross-instance reuse/invalidation, mutation races, refresh, expiry,
configuration isolation, bounded payloads, fallback, authorization after cache hits,
fresh signatures, and deletion invalidation. B2 writes in tests are mocked.
