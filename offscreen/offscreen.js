// Long-lived inference executor.
//
// The MV3 service worker has a short event/request lifetime. Inference
// requests run here instead: an offscreen extension document is not a service
// worker, so it is the right place for work that may outlive the worker's
// request timer. The offscreen document uses only the runtime extension API;
// fetch, AbortController, ReadableStream, and TextDecoder are web APIs.

import { sanitizeResponseHeaders, truncateText } from "../lib/validation.js";

const PORT_NAME = "opencode-offscreen";
const CONNECT_TIMEOUT_MS = 300000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BODY = 65536;
const HEARTBEAT_MS = 20000;

/** @type {Map<string, {controller: AbortController, cancelled: boolean, timedOut: boolean, connectTimer: any}>} */
const active = new Map();

let port = null;
let connectAttempts = 0;

connect();

setInterval(() => {
  if (active.size > 0) {
    safePost({ type: "ping" });
  }
}, HEARTBEAT_MS);

function connect() {
  if (port) return;

  try {
    port = chrome.runtime.connect({ name: PORT_NAME });
    connectAttempts = 0;
  } catch {
    // The service worker will close and recreate this document if it needs a
    // fresh connection. A couple of short retries cover startup races, but do
    // not spin in a reconnect loop while idle.
    if (connectAttempts < 2) {
      connectAttempts += 1;
      setTimeout(connect, 250 * connectAttempts);
    }
    return;
  }

  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    abortAll();
  });

  safePost({ type: "offscreen-ready" });
}

function abortAll() {
  for (const entry of active.values()) {
    entry.cancelled = true;
    entry.controller.abort();
    clearTimeout(entry.connectTimer);
  }
  active.clear();
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "start") {
    startRequest(message);
    return;
  }

  if (message.type === "cancel") {
    const entry = active.get(message.id);
    if (entry) {
      entry.cancelled = true;
      entry.controller.abort();
    }
    return;
  }

  if (message.type === "ping") {
    safePost({ type: "pong" });
  }
}

function startRequest(message) {
  if (!message.id || active.has(message.id)) return;

  const entry = {
    controller: new AbortController(),
    cancelled: false,
    timedOut: false,
    connectTimer: null
  };
  active.set(message.id, entry);

  void runRequest(message, entry).finally(() => {
    clearTimeout(entry.connectTimer);
    active.delete(message.id);
  });
}

async function runRequest(message, entry) {
  const {
    id,
    url,
    method = "POST",
    headers = {},
    body,
    stream = false,
    baseOrigin,
    maxResponseBytes = MAX_RESPONSE_BYTES
  } = message;

  let response;
  entry.connectTimer = setTimeout(() => {
    entry.timedOut = true;
    entry.controller.abort();
  }, CONNECT_TIMEOUT_MS);

  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: entry.controller.signal,
      redirect: "error",
      cache: "no-store"
    });
  } catch (error) {
    if (entry.cancelled) {
      safePost({ type: "cancelled", id });
    } else if (entry.timedOut) {
      postError(id, "CONNECT_TIMEOUT", "The upstream API did not respond in time.");
    } else {
      postError(id, "NETWORK_ERROR", error?.message || "Network request failed.");
    }
    return;
  } finally {
    clearTimeout(entry.connectTimer);
  }

  try {
    const finalUrl = new URL(response.url);
    if (finalUrl.origin !== baseOrigin) {
      postError(id, "UNEXPECTED_REDIRECT", "The upstream response came from an unexpected origin.");
      return;
    }
  } catch {
    postError(id, "UNEXPECTED_REDIRECT", "The upstream response URL could not be validated.");
    return;
  }

  const responseHeaders = sanitizeResponseHeaders(response.headers);

  if (!response.ok) {
    let text = "";
    try {
      const result = await readTextLimited(response, MAX_ERROR_BODY);
      text = result.text;
    } catch {
      // Keep the HTTP status even if the error body cannot be read.
    }
    postError(id, "UPSTREAM_HTTP_ERROR", `Upstream returned HTTP ${response.status}.`, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: truncateText(text, MAX_ERROR_BODY)
    });
    return;
  }

  safePost({
    type: "accepted",
    id,
    status: response.status,
    headers: responseHeaders
  });

  if (!stream) {
    let result;
    try {
      result = await readTextLimited(response, maxResponseBytes);
    } catch (error) {
      if (entry.cancelled) {
        safePost({ type: "cancelled", id });
      } else {
        postError(id, "RESPONSE_READ_ERROR", error?.message || "Could not read the upstream response.");
      }
      return;
    }

    if (result.truncated) {
      postError(id, "RESPONSE_TOO_LARGE", "The upstream response exceeded the bridge limit.", {
        status: response.status,
        headers: responseHeaders,
        body: truncateText(result.text, MAX_ERROR_BODY)
      });
      return;
    }

    safePost({
      type: "response",
      id,
      status: response.status,
      headers: responseHeaders,
      body: result.text
    });
    safePost({ type: "done", id });
    return;
  }

  if (!response.body) {
    safePost({ type: "done", id });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let responseBytes = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;

      responseBytes += value.byteLength;
      if (responseBytes > maxResponseBytes) {
        try {
          await reader.cancel();
        } catch {
          // Ignore.
        }
        postError(id, "RESPONSE_TOO_LARGE", "The upstream stream exceeded the bridge limit.", {
          status: response.status,
          headers: responseHeaders
        });
        return;
      }

      const text = decoder.decode(value, { stream: true });
      if (text) {
        safePost({ type: "chunk", id, data: text });
      }
    }

    const tail = decoder.decode();
    if (tail) {
      safePost({ type: "chunk", id, data: tail });
    }
    safePost({ type: "done", id });
  } catch (error) {
    if (entry.cancelled) {
      safePost({ type: "cancelled", id });
    } else if (entry.timedOut) {
      postError(id, "CONNECT_TIMEOUT", "The upstream API did not respond in time.");
    } else {
      postError(id, "STREAM_ERROR", error?.message || "The upstream stream ended unexpectedly.");
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore.
    }
  }
}

function postError(id, code, message, details = {}) {
  safePost({
    type: "error",
    id,
    error: {
      code,
      message,
      ...details
    }
  });
}

function safePost(message) {
  if (!port) return false;
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

async function readTextLimited(response, maxBytes) {
  if (!response.body) {
    return { text: "", truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let text = "";
  let truncated = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        const remaining = value.byteLength - (total - maxBytes);
        if (remaining > 0) {
          text += decoder.decode(value.slice(0, remaining), { stream: true });
        }
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // Ignore.
        }
        break;
      }

      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { text, truncated };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore.
    }
  }
}
