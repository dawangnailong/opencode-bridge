# Privacy

OpenCode Bridge is a local transport layer. It does not operate a server and it
does not collect analytics, telemetry, or usage data.

## What stays local

- The API key is stored in `chrome.storage.local` in the user's Chrome profile.
- Allowed origins, provider choice, custom base URL, and the client User-Agent
  are stored in `chrome.storage.local`.
- Requests and responses pass through the extension service worker and the
  long-lived offscreen executor in memory.
- The extension does not write prompts, responses, API keys, or session contents
  to logs or to remote storage.

`chrome.storage.local` is not encrypted and is not a hardware-backed secret
store. See [SECURITY.md](SECURITY.md).

## What leaves the browser

When the user sends a request, the extension forwards it over HTTPS to the
configured OpenCode endpoint (or to a custom HTTPS base URL chosen by the user).
That request includes:

- the user's API key in the `Authorization` header;
- the request body supplied by the web page;
- the session ID;
- the configured client User-Agent;
- standard HTTP metadata added by Chrome.

OpenCode's terms and privacy policy govern that data. Model-specific training
and retention terms vary; users should check the OpenCode Console privacy
settings and the official documentation. Some free or contributor models have
different training/retention terms.

## What the web page can see

- The page can see the request body it created.
- The page can see the response body and headers forwarded by the extension.
- The page cannot see the API key.
- The page cannot read the extension's allowed-origin list or other settings.
- A page on an allowed origin is trusted at the origin level; any script running
  in that origin can use the bridge.

## No collection

This project does not include:

- analytics;
- telemetry;
- crash reporting;
- remote configuration;
- advertising;
- account systems;
- a shared proxy server.

## User responsibility

The extension does not determine whether a particular use complies with
OpenCode's subscription policy. Users are responsible for reviewing and
following the official terms:

- <https://opencode.ai/legal/terms-of-service>
- <https://opencode.ai/docs/console/go>
- <https://opencode.ai/docs/console/api/inference>
