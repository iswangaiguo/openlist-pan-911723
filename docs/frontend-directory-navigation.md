# Fast return navigation

Frontend source is pinned by `frontend-patches/upstream.json`. The regular build
fetches that upstream revision, verifies/applies `directory-navigation.patch`, and
runs the navigation tests before building. This prevents a subsequent Cloudflare
or GitHub build from silently replacing this fix with vanilla upstream assets.
To upgrade upstream, update the pin and rebase/test the patch together.
`FRONTEND_DIST` remains an explicit escape hatch for an already-built frontend;
it must point at patched artifacts if this feature is required.

Directory lists in all-items and numbered-pagination modes are remembered in
per-tab memory (32 entries, 2 MiB total, 512 KiB per entry, 2 minutes maximum).
The scope includes current user, role/permissions, base path, directory password,
path and paging settings. Snapshots are not persisted to localStorage or disk.
The lifetime is shortened to precede any signed-link expiry by 10 seconds.
Infinite-scroll/load-more modes keep their existing loading flow.

On return navigation the previous list is rendered synchronously while a fresh
`/api/fs/list` request runs. This is provisional display of previously viewed data,
not an authorization decision. That request still checks current permissions,
reads the shared Worker cache, and regenerates download signatures. A denial or
network failure removes the provisional list. Server-side revocation cannot be
known by the browser until that response arrives; there is no push subscription.
File operations always go through the existing server-side permission checks.

Mutating requests invalidate browser snapshots before and after completion,
including failed/partial writes. Explicit Refresh bypasses them. Login/logout and
cross-tab token changes clear snapshots and any legacy file history. A navigation
version guard prevents slower old responses from replacing a newer screen; a
mutation generation guard prevents old responses repopulating cleared snapshots.
Browser reload starts with an empty snapshot cache, so this primarily improves
navigation within the current tab, not the very first visit.

The `.obj-box` element exposes `data-directory-state=revalidating` and `aria-busy`
during background verification for accessibility and read-only UI verification.
There is no additional full-page spinner for a restored snapshot.

Run tests with:

```
FRONTEND_TEST_REPO=/path/to/patched/frontend node --test scripts/tests/frontend-directory.test.mjs
```

The tests exercise the actual navigation hook with controlled transport/store
adapters: immediate display while the response is pending, background replacement,
denial/error cleanup, force refresh, identity isolation, mutation and navigation
races, eviction bounds and expiring signatures.
