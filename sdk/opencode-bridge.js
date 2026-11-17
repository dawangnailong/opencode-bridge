// OpenCode Bridge web SDK.
//
// This file is intentionally dependency-free. The page never sees an API key;
// it only talks to the companion Chrome extension over chrome.runtime.
//
// Usage:
//   const bridge = new OpenCodeBridge({ extensionId: "..." });
//   const conversation = bridge.createConversation();
//   const stream = await conversation.chat.completions.create({ ... }, { signal });
//   for await (const chunk of stream) { ... }

const PROTOCOL_VERSION = 1;
const DEFAULT_PORT_NAME = "opencode-bridge";
const DEFAULT_HELLO_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 20000;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export class OpenCodeBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = "OpenCodeBridgeError";
    this.code = code;
    Object.assign(this, details);
  }
}

export class SSEParser {
  constructor() {
    this._line = "";
    this._lastWasCR = false;
    this._data = [];
    this._event = "";
    this._id = "";
    this._retry = null;
  }

  feed(text) {
    const events = [];
    if (!text) return events;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (char === "\r") {
        this._dispatchLine(events);
        this._line = "";
        this._lastWasCR = true;
      } else if (char === "\n") {
        if (this._lastWasCR) {
          this._lastWasCR = false;
          continue;
        }
        this._dispatchLine(events);
        this._line = "";
      } else {
        this._lastWasCR = false;
        this._line += char;
      }
    }

    return events;
  }

  flush() {
    const events = [];
    if (this._line.length) {
      this._dispatchLine(events);
      this._line = "";
    }
    if (this._data.length) {
      this._dispatchEvent(events);
    }
    return events;
  }

  _dispatchLine(events) {
    const line = this._line;
    if (line === "") {
      this._dispatchEvent(events);
      return;
    }
    if (line.startsWith(":")) {
      return;
    }

    const colon = line.indexOf(":");
    let field;
    let value;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }

    if (field === "data") {
      this._data.push(value);
    } else if (field === "event") {
      this._event = value;
    } else if (field === "id") {
      this._id = value;
    } else if (field === "retry") {
      const retry = Number.parseInt(value, 10);
      if (!Number.isNaN(retry)) this._retry = retry;
    }
  }

  _dispatchEvent(events) {
    if (!this._data.length) {
      this._event = "";
      return;
    }
    events.push({
      event: this._event || "message",
      data: this._data.join("\n"),
      id: this._id || undefined,
      retry: this._retry ?? undefined
    });
    this._data = [];
    this._event = "";
  }
}

export class Conversation {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.sessionId = options.sessionId || createId("ses_");
    if (!SESSION_ID_RE.test(this.sessionId)) {
      throw new OpenCodeBridgeError(
        "BAD_SESSION_ID",
        "sessionId must be 1-128 characters: letters, digits, dot, underscore, colon, or hyphen."
      );
    }

    this.chat = {
      completions: {
        create: (body, requestOptions = {}) =>
          bridge._create("chat.completions", body, this.sessionId, requestOptions)
      }
    };
    this.responses = {
      create: (body, requestOptions = {}) =>
        bridge._create("responses", body, this.sessionId, requestOptions)
    };
  }

  createFetch(options = {}) {
    const conversation = this;
    const bridge = this.bridge;
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const matchUrl = options.matchUrl || defaultMatchUrl;

    return async function bridgeFetch(input, init = {}) {
      let urlString;
      let request = null;

      if (typeof input === "string" || input instanceof URL) {
        urlString = String(input);
      } else if (input && typeof input === "object" && typeof input.url === "string") {
        request = input;
        urlString = input.url;
      } else {
        return nativeFetch(input, init);
      }

      let path;
      try {
        const base = globalThis.location?.href || "https://opencode.ai/";
        path = new URL(urlString, base).pathname;
      } catch {
        return nativeFetch(input, init);
      }

      if (!matchUrl(urlString)) {
        return nativeFetch(input, init);
      }

      const api = path.endsWith("/chat/completions")
        ? "chat.completions"
        : path.endsWith("/responses")
          ? "responses"
          : null;
      if (!api) {
        return nativeFetch(input, init);
      }

      let bodyText = "";
      if (init.body != null) {
        bodyText = typeof init.body === "string"
          ? init.body
          : await new Response(init.body).text();
      } else if (request) {
        bodyText = await request.clone().text();
      }

      let body;
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        throw new OpenCodeBridgeError("BAD_BODY", "Request body is not valid JSON.");
      }

      const signal = init.signal || request?.signal;

      if (body.stream === true) {
        const raw = await bridge._openRawStream({
          api,
          body,
          sessionId: conversation.sessionId,
          signal
        });
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of raw.iterator) {
                controller.enqueue(encoder.encode(chunk));
              }
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
          cancel() {
            raw.abort();
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }

      const response = await bridge._request({
        api,
        body,
        sessionId: conversation.sessionId,
        signal
      });
      return new Response(response.body || null, {
        status: response.status,
        headers: response.headers || {}
      });
    };
  }
}

export class OpenCodeBridge {
  constructor(options = {}) {
    if (!options.extensionId || typeof options.extensionId !== "string") {
      throw new OpenCodeBridgeError("EXTENSION_ID_REQUIRED", "extensionId is required.");
    }
    this.extensionId = options.extensionId;
    this.portName = options.portName || DEFAULT_PORT_NAME;
    this.helloTimeoutMs = Number(options.helloTimeoutMs) || DEFAULT_HELLO_TIMEOUT_MS;

    this._port = null;
    this._ready = null;
    this._hello = null;
    this._pending = new Map();
    this._heartbeat = null;
    this._closed = false;
  }

  async connect() {
    await this._ensurePort();
    return this;
  }

  createConversation(options = {}) {
    return new Conversation(this, options);
  }

  get models() {
    return {
      list: (options = {}) => this._request({
        api: "models.list",
        body: null,
        sessionId: null,
        signal: options.signal
      })
    };
  }

  close() {
    this._closed = true;
    this._stopHeartbeat();
    const error = new OpenCodeBridgeError("CLOSED", "Bridge was closed.");
    this._failAll(error);
    try {
      this._port?.disconnect();
    } catch {
      // Ignore.
    }
    this._port = null;
    this._ready = null;
    this._hello = null;
  }

  // -------------------------------------------------------------------------
  // Port lifecycle
  // -------------------------------------------------------------------------

  _ensurePort() {
    if (this._closed) {
      return Promise.reject(new OpenCodeBridgeError("CLOSED", "Bridge was closed."));
    }
    if (this._port) {
      return this._ready;
    }

    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.connect) {
      return Promise.reject(new OpenCodeBridgeError(
        "NO_CHROME_RUNTIME",
        "chrome.runtime.connect is not available. Open this page in Chrome and add its exact origin in the extension options."
      ));
    }

    let port;
    try {
      port = runtime.connect(this.extensionId, { name: this.portName });
    } catch (error) {
      return Promise.reject(new OpenCodeBridgeError(
        "CONNECT_FAILED",
        error?.message || "Could not connect to the extension."
      ));
    }

    this._port = port;
    this._ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._hello = null;
        try {
          port.disconnect();
        } catch {
          // Ignore.
        }
        this._port = null;
        this._ready = null;
        reject(new OpenCodeBridgeError(
          "HELLO_TIMEOUT",
          "The extension did not respond. Is it installed and enabled?"
        ));
      }, this.helloTimeoutMs);

      this._hello = {
        resolve: (message) => {
          clearTimeout(timer);
          this._hello = null;
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          this._hello = null;
          reject(error);
        }
      };
    });

    port.onMessage.addListener((message) => this._dispatch(message));
    port.onDisconnect.addListener(() => {
      const error = new OpenCodeBridgeError(
        "SW_DISCONNECTED",
        "The extension service worker disconnected. The request was not resumed."
      );
      this._port = null;
      this._ready = null;
      this._hello?.reject(error);
      this._hello = null;
      this._failAll(error);
    });

    try {
      port.postMessage({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    } catch (error) {
      this._hello?.reject(new OpenCodeBridgeError(
        "CONNECT_FAILED",
        error?.message || "Could not send hello to the extension."
      ));
      this._port = null;
      this._ready = null;
      try {
        port.disconnect();
      } catch {
        // Ignore.
      }
    }

    return this._ready;
  }

  _dispatch(message) {
    if (!message || typeof message !== "object") return;

    if (message.type === "hello") {
      this._hello?.resolve(message);
      return;
    }

    if (message.type === "pong") {
      return;
    }

    if (message.type === "fatal") {
      const error = bridgeError(message.error);
      this._hello?.reject(error);
      this._hello = null;
      this._failAll(error);
      try {
        this._port?.disconnect();
      } catch {
        // Ignore.
      }
      this._port = null;
      this._ready = null;
      return;
    }

    const pending = message.requestId ? this._pending.get(message.requestId) : null;
    if (!pending) return;

    if (message.type === "accepted") {
      pending.onAccepted?.(message);
    } else if (message.type === "chunk") {
      pending.onChunk?.(message.data);
    } else if (message.type === "response") {
      pending.onResponse?.(message);
    } else if (message.type === "done") {
      pending.onDone?.();
    } else if (message.type === "error") {
      pending.fail?.(bridgeError(message.error));
    } else if (message.type === "cancelled") {
      pending.fail?.(new OpenCodeBridgeError("ABORTED", "Request was cancelled."));
    }
  }

  _send(message) {
    if (!this._port) {
      throw new OpenCodeBridgeError("SW_DISCONNECTED", "No connection to the extension.");
    }
    this._port.postMessage(message);
  }

  _failAll(error) {
    for (const pending of this._pending.values()) {
      try {
        pending.fail?.(error);
      } catch {
        // Ignore.
      }
    }
    this._pending.clear();
    this._stopHeartbeatIfIdle();
  }

  _startHeartbeat() {
    if (this._heartbeat) return;
    this._heartbeat = setInterval(() => {
      try {
        this._send({ type: "ping" });
      } catch {
        // The disconnect handler will reject pending requests.
      }
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  _stopHeartbeatIfIdle() {
    if (this._pending.size === 0) {
      this._stopHeartbeat();
    }
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  _create(api, body, sessionId, options = {}) {
    if (body && body.stream === true) {
      return this._openStream(api, body, sessionId, options);
    }
    return this._request({
      api,
      body,
      sessionId,
      signal: options.signal
    });
  }

  async _request({ api, body, sessionId, signal }) {
    await this._ensurePort();
    const requestId = createId("req_");

    return new Promise((resolve, reject) => {
      let settled = false;
      let signalCleanup = null;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        this._pending.delete(requestId);
        signalCleanup?.();
        this._stopHeartbeatIfIdle();
        if (error) reject(error);
        else resolve(value);
      };

      const abort = () => {
        try {
          this._send({ type: "cancel", requestId });
        } catch {
          // Ignore; the port may already be gone.
        }
        finish(new OpenCodeBridgeError("ABORTED", "Request was aborted."));
      };

      const pending = {
        fail: (error) => finish(error),
        onResponse: (message) => finish(null, {
          status: message.status,
          headers: message.headers || {},
          body: message.body ?? "",
          json: parseJson(message.body)
        }),
        onDone: () => {
          if (!settled) {
            finish(new OpenCodeBridgeError("PROTOCOL_ERROR", "Upstream ended without a response."));
          }
        }
      };

      this._pending.set(requestId, pending);
      this._startHeartbeat();

      if (signal) {
        if (signal.aborted) {
          abort();
          return;
        }
        const onAbort = () => abort();
        signal.addEventListener("abort", onAbort, { once: true });
        signalCleanup = () => signal.removeEventListener("abort", onAbort);
      }

      try {
        this._send({
          type: "request",
          requestId,
          api,
          body: body ?? null,
          sessionId
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  async _openStream(api, body, sessionId, options = {}) {
    const raw = await this._openRawStream({
      api,
      body,
      sessionId,
      signal: options.signal
    });
    const iterator = this._parseStream(raw.iterator, options.onEvent, raw.abort);
    iterator.requestId = raw.requestId;
    iterator.abort = raw.abort;
    return iterator;
  }

  async _openRawStream({ api, body, sessionId, signal }) {
    await this._ensurePort();
    const requestId = createId("req_");
    const queue = createQueue();

    let acceptedResolve;
    let acceptedReject;
    const accepted = new Promise((resolve, reject) => {
      acceptedResolve = resolve;
      acceptedReject = reject;
    });

    let settled = false;
    let signalCleanup = null;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      this._pending.delete(requestId);
      signalCleanup?.();
      this._stopHeartbeatIfIdle();
      if (error) acceptedReject(error);
    };

    const abort = () => {
      if (settled) return;
      try {
        this._send({ type: "cancel", requestId });
      } catch {
        // Ignore.
      }
      const error = new OpenCodeBridgeError("ABORTED", "Request was aborted.");
      queue.push({ type: "error", error });
      finish(error);
    };

    const pending = {
      onAccepted: (message) => acceptedResolve(message),
      onChunk: (data) => queue.push({ type: "chunk", data }),
      onDone: () => {
        // Resolve the handshake even if the extension skipped "accepted";
        // the queue immediately ends, so the consumer sees a clean end.
        acceptedResolve({});
        queue.push({ type: "end" });
        finish();
      },
      fail: (error) => {
        queue.push({ type: "error", error });
        finish(error);
      }
    };

    this._pending.set(requestId, pending);
    this._startHeartbeat();

    if (signal) {
      if (signal.aborted) {
        abort();
      } else {
        const onAbort = () => abort();
        signal.addEventListener("abort", onAbort, { once: true });
        signalCleanup = () => signal.removeEventListener("abort", onAbort);
      }
    }

    if (!settled) {
      try {
        this._send({
          type: "request",
          requestId,
          api,
          body,
          sessionId
        });
      } catch (error) {
        pending.fail(error);
      }
    }

    await accepted;

    return {
      requestId,
      iterator: rawIterator(queue),
      abort
    };
  }

  async *_parseStream(rawIterator, onEvent, abort) {
    const parser = new SSEParser();
    let completed = false;

    try {
      for await (const chunk of rawIterator) {
        for (const event of parser.feed(chunk)) {
          onEvent?.(event);
          if (event.data === "[DONE]") {
            completed = true;
            return;
          }
          if (!event.data) continue;
          yield parseEventValue(event.data);
        }
      }

      for (const event of parser.flush()) {
        onEvent?.(event);
        if (event.data === "[DONE]") {
          completed = true;
          return;
        }
        if (event.data) {
          yield parseEventValue(event.data);
        }
      }

      completed = true;
    } finally {
      if (!completed) {
        abort?.();
      }
    }
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.OpenCodeBridge = OpenCodeBridge;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createQueue() {
  const items = [];
  const waiters = [];

  return {
    push(item) {
      const waiter = waiters.shift();
      if (waiter) waiter(item);
      else items.push(item);
    },
    next() {
      if (items.length) return Promise.resolve(items.shift());
      return new Promise((resolve) => waiters.push(resolve));
    }
  };
}

async function* rawIterator(queue) {
  while (true) {
    const item = await queue.next();
    if (item.type === "chunk") {
      yield item.data;
    } else if (item.type === "end") {
      return;
    } else if (item.type === "error") {
      throw item.error;
    }
  }
}

function createId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function bridgeError(payload) {
  const error = new OpenCodeBridgeError(
    payload?.code || "UPSTREAM_ERROR",
    payload?.message || "Upstream request failed."
  );
  if (payload && typeof payload === "object") {
    Object.assign(error, payload);
  }
  return error;
}

function parseJson(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseEventValue(data) {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function defaultMatchUrl(url) {
  try {
    const base = globalThis.location?.href || "https://opencode.ai/";
    const path = new URL(url, base).pathname;
    return path.endsWith("/chat/completions") || path.endsWith("/responses");
  } catch {
    return false;
  }
}
