// Shared, dependency-free validation helpers.
// This module is imported by the MV3 service worker and by Node tests.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const API_TYPES = new Set(["chat.completions", "responses", "models.list"]);

const DROP_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade"
]);

export function normalizeOrigin(input) {
  if (typeof input !== "string") {
    return { ok: false, error: "Origin must be a string." };
  }
  const raw = input.trim();
  if (!raw) {
    return { ok: false, error: "Origin is empty." };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Invalid URL." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Only http and https origins are supported." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Origins must not contain credentials." };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "Origins must not contain a query or hash." };
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return { ok: false, error: "Origins must not contain a path." };
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, error: "Plain HTTP is only allowed for localhost." };
  }
  if (!url.hostname) {
    return { ok: false, error: "Origin is missing a host." };
  }

  return { ok: true, origin: url.origin };
}

export function isOriginAllowed(origin, allowedOrigins) {
  if (typeof origin !== "string" || !origin || origin === "null") {
    return false;
  }
  if (!Array.isArray(allowedOrigins)) {
    return false;
  }
  return allowedOrigins.some((allowed) => typeof allowed === "string" && allowed === origin);
}

export function parseBaseUrl(input) {
  if (typeof input !== "string") {
    return { ok: false, error: "Base URL must be a string." };
  }
  const raw = input.trim();
  if (!raw) {
    return { ok: false, error: "Base URL is empty." };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Invalid base URL." };
  }

  if (url.protocol !== "https:") {
    return { ok: false, error: "Custom base URLs must use HTTPS." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Base URLs must not contain credentials." };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "Base URLs must not contain a query or hash." };
  }
  if (isForbiddenCustomHost(url.hostname)) {
    return { ok: false, error: "Custom base URLs may not point at localhost or a private address." };
  }

  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, baseUrl: `${url.origin}${path}` };
}

export function isForbiddenCustomHost(hostname) {
  if (typeof hostname !== "string") {
    return true;
  }
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  if (host === "metadata.google.internal") return true;
  return false;
}

export function providerBaseUrl(provider, customBaseUrl) {
  if (provider === "console") {
    return "https://opencode.ai/inference";
  }
  if (provider === "go") {
    return "https://opencode.ai/inference/go";
  }
  if (provider === "custom") {
    const parsed = parseBaseUrl(customBaseUrl);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return parsed.baseUrl;
  }
  throw new Error("Unknown provider.");
}

export function buildEndpoints(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return {
    base,
    chat: `${base}/openai/v1/chat/completions`,
    responses: `${base}/openai/v1/responses`,
    models: `${base}/v1/models`
  };
}

export function endpointFor(api, endpoints) {
  if (api === "chat.completions") return endpoints.chat;
  if (api === "responses") return endpoints.responses;
  if (api === "models.list") return endpoints.models;
  throw new Error("Unsupported API.");
}

export function byteLength(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return new TextEncoder().encode(text).byteLength;
}

export function validateRequestBody(api, body) {
  if (!API_TYPES.has(api)) {
    return { ok: false, error: "Unsupported API type." };
  }

  if (api === "models.list") {
    if (body !== undefined && body !== null) {
      return { ok: false, error: "models.list does not accept a request body." };
    }
    return { ok: true };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  if (typeof body.model !== "string" || body.model.length < 1 || body.model.length > 200) {
    return { ok: false, error: "body.model must be a non-empty string of at most 200 characters." };
  }
  if ("stream" in body && typeof body.stream !== "boolean") {
    return { ok: false, error: "body.stream must be a boolean." };
  }
  if (api === "chat.completions" && body.messages !== undefined && !Array.isArray(body.messages)) {
    return { ok: false, error: "body.messages must be an array." };
  }
  if (api === "responses" && body.input !== undefined && typeof body.input !== "string" && !Array.isArray(body.input)) {
    return { ok: false, error: "body.input must be a string or an array." };
  }

  return { ok: true };
}

export function isValidRequestId(value) {
  return typeof value === "string" && REQUEST_ID_RE.test(value);
}

export function isValidSessionId(value) {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

export function truncateText(text, maxBytes = 65536) {
  if (typeof text !== "string") {
    return "";
  }
  if (byteLength(text) <= maxBytes) {
    return text;
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(text).slice(0, maxBytes);
  return decoder.decode(bytes);
}

export function sanitizeResponseHeaders(headers) {
  const out = {};
  if (!headers) {
    return out;
  }

  const entries = typeof headers.entries === "function" ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) {
    const lower = String(key).toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(lower)) {
      continue;
    }
    if (lower.startsWith("access-control-")) {
      continue;
    }
    if (lower.startsWith("proxy-")) {
      continue;
    }
    out[lower] = String(value);
  }
  return out;
}
