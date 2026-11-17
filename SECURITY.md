# Security design

This document describes the trust boundaries of OpenCode Bridge. It is not a
claim that the extension is suitable for high-security environments.

## Trust model

- The user trusts the extension code installed in their own Chrome profile.
- The extension trusts web pages only if their exact Origin is listed in the
  options page.
- The extension does **not** trust the web page with the API key.
- The extension does **not** trust the web page to choose arbitrary URLs,
  methods, headers, or authorization values.
- OpenCode is an external service. Requests sent to it are subject to OpenCode's
  terms and privacy policy.

## Origin validation

`externally_connectable.matches` is static in the manifest. This build uses
`http://*/*` and `https://*/*`, so any http/https page can obtain the
`chrome.runtime.connect` entry point. That is only an entry point: every port is
validated against the runtime allowlist.

Validation rules:

- Read `port.sender.origin`.
- Reject missing, empty, `null`, or non-http(s) origins.
- If `port.sender.url` is present, parse it and require its origin to equal
  `sender.origin`.
- Require an exact string match against `allowedOrigins`.
- No prefix matching, wildcard matching, or subdomain matching.
- Default `allowedOrigins` is an empty array.

Consequences:

- A page on an allowed origin is fully trusted by this extension. Any script
  running in that origin can use the bridge, including third-party scripts.
  Origin-level authorization cannot distinguish scripts inside the same origin.
- If the allowlist is misconfigured, the bridge can be used by a page the user
  did not intend to authorize.

## Trusted extension pages

Extension pages with the same extension ID (for example the options page or a
debug harness) may use an internal `chrome.runtime.connect` port with the same
request protocol. This is not a new privilege: extension pages can already read
the saved key. The service worker still checks `sender.id` and requires
`sender.url` to start with `chrome-extension://<this-extension-id>/`.

Web pages never use this internal path; they go through
`onConnectExternal` and the runtime Origin allowlist described above.

## API key handling

- The key is stored in `chrome.storage.local`.
- `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` is
  called on install/startup to prevent content scripts from reading it. This
  build does not use content scripts, but the call is kept as defense in depth.
- The key is never sent to a web page, the SDK, a log, an error message, a URL,
  a query string, or a DNR rule.
- The key is read from storage for each upstream request and placed only in the
  `Authorization` request header.
- `chrome.storage.local` is not encrypted at rest and is not a hardware-backed
  secret store. Local malware, a compromised Chrome profile, or a process with
  access to the profile directory may be able to read it. The extension does not
  claim otherwise.

## Request validation

The page may send only:

```js
{
  type: "request",
  requestId: "req_...",
  api: "chat.completions" | "responses" | "models.list",
  body: object | null,
  sessionId: "ses_..." // optional
}
```

The extension rejects:

- unknown `api` values;
- non-object request bodies;
- missing or oversized `model`;
- non-boolean `stream`;
- invalid request IDs or session IDs;
- bodies larger than `maxBodyBytes` (default 4 MiB);
- duplicate request IDs on the same port;
- requests over the global/per-origin concurrency limits.

The page cannot provide:

- a target URL;
- an HTTP method;
- request headers;
- an `Authorization` value;
- a `User-Agent` value;
- a provider/base URL override for a single request.

This prevents the extension from becoming an open proxy.

## Network behavior

- Requests are made by the extension service worker with host permissions.
- `redirect: "error"` is used, so a 3xx response fails instead of silently
  forwarding credentials to another host.
- The final `response.url` origin is checked against the configured base URL
  origin.
- Custom base URLs must use HTTPS and may not use localhost or private address
  literals (127/8, 10/8, 192.168/16, 172.16/12, 169.254/16, 100.64/10, `::1`,
  `0.0.0.0`, `.localhost`). DNS rebinding on an allowed custom hostname is not
  fully preventable from an extension; treat custom base URLs as trusted input.
- Custom base URLs require an optional host permission granted from the options
  page.
- The extension does not disable CORS, does not use `--disable-web-security`,
  and does not modify `Access-Control-Allow-Origin`.

Residual risk: a user can intentionally configure a public custom base URL and
send their key there. That is an explicit user decision; the options UI warns
about the permission and the URL is validated, but the extension cannot know
whether the custom service is trustworthy.

## Streaming and cancellation

- SSE bodies are read with `ReadableStream` and decoded with a streaming
  `TextDecoder`.
- Response headers that would be incorrect after browser decompression or
  re-framing are stripped: `content-encoding`, `content-length`,
  `transfer-encoding`, `connection`, `set-cookie`, etc.
- Cancellation aborts the upstream fetch via `AbortController`. Partial usage
  may still be billed by OpenCode.
- No automatic retry is performed. Retrying a POST can duplicate charges.

## Service worker lifetime and offscreen execution

MV3 service workers can be stopped after idle periods and long requests can hit
the per-event/request limit. To keep long code-agent turns from depending on the
service worker's request timer, inference requests (both streaming and
non-streaming) run in an **offscreen document**:

- The service worker validates the request, enforces concurrency/body limits,
  and routes messages. Its event handlers return quickly.
- The offscreen document performs `fetch`, reads the response body, decodes
  UTF-8, and sends chunks back through the service worker.
- The offscreen document sends a heartbeat to the service worker every 20
  seconds while requests are active; the service worker also creates a
  30-second alarm. The page SDK sends its own 20-second heartbeat.
- The offscreen document is an extension context with host permissions; the API
  key is in its memory but never in a web page.
- The offscreen document uses the `WORKERS` reason because Chrome does not have
  a network reason. This is a review consideration if published.
- Only one offscreen document exists per profile. If Chrome reclaims it, the
  extension update reloads it, or the service worker restarts, active streams
  fail with `OFFSCREEN_DISCONNECTED` / `SW_DISCONNECTED`; the bridge does not
  pretend the stream was resumed.
- If offscreen creation is unavailable, the bridge falls back to service worker
  `fetch`, which is subject to the shorter first-byte/request limits. The
  fallback is logged as a non-sensitive warning.

## Logging

- No request prompts, response bodies, API keys, or session contents are logged.
- A non-sensitive warning may be logged if a DNR rule cannot be applied.
- The options page does not render the saved key; it only shows a mask.

## Chrome Web Store considerations

If this extension is published, expect review of:

- broad `externally_connectable` matches;
- `optional_host_permissions` for custom base URLs;
- `declarativeNetRequest` header modification;
- the `offscreen` permission and the `WORKERS` justification;
- storage of a sensitive API key;
- the single-purpose policy, privacy disclosure, and limited-use requirements.

Do not add remote code, telemetry, or a shared API key to a published build.

## Reporting

This is a local open-source project. If you find a security issue, open a private
report with the maintainer rather than publishing a working exploit.
