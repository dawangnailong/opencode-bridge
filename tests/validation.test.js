import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEndpoints,
  byteLength,
  isForbiddenCustomHost,
  isOriginAllowed,
  isValidRequestId,
  isValidSessionId,
  normalizeOrigin,
  parseBaseUrl,
  providerBaseUrl,
  sanitizeResponseHeaders,
  truncateText,
  validateRequestBody
} from "../lib/validation.js";

test("normalizes a bare HTTPS origin", () => {
  assert.deepEqual(normalizeOrigin("https://example.com"), {
    ok: true,
    origin: "https://example.com"
  });
});

test("normalizes a localhost HTTP origin with a port", () => {
  assert.deepEqual(normalizeOrigin("http://localhost:8000"), {
    ok: true,
    origin: "http://localhost:8000"
  });
});

test("rejects plain HTTP for a non-loopback host", () => {
  assert.equal(normalizeOrigin("http://example.com").ok, false);
});

test("rejects origins with a path", () => {
  assert.equal(normalizeOrigin("https://example.com/app").ok, false);
});

test("rejects credentials and query strings", () => {
  assert.equal(normalizeOrigin("https://user:pass@example.com").ok, false);
  assert.equal(normalizeOrigin("https://example.com?x=1").ok, false);
});

test("rejects non-http schemes", () => {
  assert.equal(normalizeOrigin("file:///tmp/page.html").ok, false);
});

test("matches origins exactly, not by prefix", () => {
  const allowed = ["https://example.com"];
  assert.equal(isOriginAllowed("https://example.com", allowed), true);
  assert.equal(isOriginAllowed("https://example.com.evil", allowed), false);
  assert.equal(isOriginAllowed("https://example.com:8443", allowed), false);
  assert.equal(isOriginAllowed("null", allowed), false);
});

test("parses a base URL and strips a trailing slash", () => {
  assert.deepEqual(parseBaseUrl("https://example.com/inference/"), {
    ok: true,
    baseUrl: "https://example.com/inference"
  });
});

test("rejects HTTP, localhost, and private custom base URLs", () => {
  assert.equal(parseBaseUrl("http://example.com").ok, false);
  assert.equal(parseBaseUrl("https://localhost").ok, false);
  assert.equal(parseBaseUrl("https://127.0.0.1").ok, false);
  assert.equal(parseBaseUrl("https://192.168.1.10").ok, false);
});

test("detects private address literals", () => {
  assert.equal(isForbiddenCustomHost("127.0.0.1"), true);
  assert.equal(isForbiddenCustomHost("10.0.0.1"), true);
  assert.equal(isForbiddenCustomHost("172.16.0.1"), true);
  assert.equal(isForbiddenCustomHost("192.168.1.1"), true);
  assert.equal(isForbiddenCustomHost("169.254.169.254"), true);
  assert.equal(isForbiddenCustomHost("example.com"), false);
});

test("builds provider base URLs", () => {
  assert.equal(providerBaseUrl("console", ""), "https://opencode.ai/inference");
  assert.equal(providerBaseUrl("go", ""), "https://opencode.ai/inference/go");
});

test("builds endpoint paths", () => {
  assert.deepEqual(buildEndpoints("https://opencode.ai/inference/go/"), {
    base: "https://opencode.ai/inference/go",
    chat: "https://opencode.ai/inference/go/openai/v1/chat/completions",
    responses: "https://opencode.ai/inference/go/openai/v1/responses",
    models: "https://opencode.ai/inference/go/v1/models"
  });
});

test("accepts a valid chat request body", () => {
  assert.equal(validateRequestBody("chat.completions", {
    model: "kimi-k3",
    messages: [{ role: "user", content: "hi" }],
    stream: true
  }).ok, true);
});

test("accepts a valid responses request body", () => {
  assert.equal(validateRequestBody("responses", {
    model: "gpt-6-luna",
    input: "hi",
    stream: false
  }).ok, true);
});

test("rejects missing models and non-boolean stream", () => {
  assert.equal(validateRequestBody("chat.completions", {
    messages: []
  }).ok, false);
  assert.equal(validateRequestBody("chat.completions", {
    model: "kimi-k3",
    stream: "yes"
  }).ok, false);
});

test("rejects a body for models.list", () => {
  assert.equal(validateRequestBody("models.list", {}).ok, false);
  assert.equal(validateRequestBody("models.list", null).ok, true);
});

test("validates request and session IDs", () => {
  assert.equal(isValidRequestId("req_abc-123"), true);
  assert.equal(isValidRequestId("bad id"), false);
  assert.equal(isValidSessionId("ses_abc-123"), true);
  assert.equal(isValidSessionId(""), false);
});

test("measures UTF-8 bytes", () => {
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("你"), 3);
});

test("truncates text by bytes", () => {
  const value = "a".repeat(100);
  assert.equal(truncateText(value, 10).length, 10);
});

test("drops hop-by-hop and sensitive response headers", () => {
  const headers = new Headers({
    "content-type": "application/json",
    "content-encoding": "gzip",
    "content-length": "10",
    "set-cookie": "a=b",
    "x-request-id": "abc",
    "access-control-allow-origin": "*"
  });
  const result = sanitizeResponseHeaders(headers);

  assert.equal(result["content-type"], "application/json");
  assert.equal(result["x-request-id"], "abc");
  assert.equal("content-encoding" in result, false);
  assert.equal("content-length" in result, false);
  assert.equal("set-cookie" in result, false);
  assert.equal("access-control-allow-origin" in result, false);
});
