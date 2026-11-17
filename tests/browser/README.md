# Browser test harness

These tests drive a real Chromium with the unpacked extension over the Chrome
DevTools Protocol. They do not use Playwright or any npm dependency.

## Quick run

```bash
CHROME_BIN=/usr/lib/chromium/chromium node tests/browser/run-all.mjs
```

Optional:

```bash
CHROME_BIN=... node tests/browser/run-all.mjs --first-byte
CHROME_BIN=... node tests/browser/run-all.mjs --long
```

`--long` runs a six-minute SSE stream through the offscreen executor.

## Files

| File | Purpose |
|---|---|
| `run-all.mjs` | Launch Chromium with the extension, run protocol + failure tests, clean up |
| `protocol-test.mjs` | Options/storage/DNR, internal trusted port, SDK, SSE, non-stream, Responses, errors, cancel |
| `failure-test.mjs` | Offscreen close/recreate, service worker stop |
| `external-page-test.mjs` | External `https://demo.test` page via CDP Fetch interception; blocked in some sandboxes |
| `cdp.mjs` | Minimal CDP client (Node global WebSocket) |
| `mock-server.mjs` | Optional HTTPS mock for Console/Go endpoints and static demo files |
| `socks-proxy.mjs` | Optional SOCKS5 proxy redirecting TLS to the local mock |
| `http-proxy.mjs` | Optional HTTP CONNECT proxy redirecting TLS to the local mock |
| `RESULTS.md` | Results and environment limitations from 2026-11-17 |

## Stubbed fetch

`protocol-test.mjs` and `failure-test.mjs` install a `fetch` stub inside the
real offscreen document. This exercises the real service worker, offscreen
routing, message protocol, SDK, SSE parser, cancellation, and lifecycle without
requiring outbound network. It does **not** verify Chrome's real network stack or
OpenCode's API.

## Real network tests

If your Chrome has normal network access, use `tests/manual-checklist.md` with a
real API key. Do not paste a key into a test file; enter it through the options
page. The mock server/proxy utilities are available if you prefer a local mock;
they use a test-only self-signed certificate and must be run only in a disposable
test profile.
