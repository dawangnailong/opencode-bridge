// HTTPS mock for OpenCode Console / Go endpoints used by browser tests.
//
// Start it directly:
//   MOCK_CERT=/tmp/cert.pem MOCK_KEY=/tmp/key.pem node tests/browser/mock-server.mjs
//
// The mock intentionally accepts any bearer token. It never contacts OpenCode.

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PORT = Number(process.env.MOCK_PORT || 9443);
const LOG_FILE = process.env.MOCK_LOG || "";
const CERT = process.env.MOCK_CERT || "";
const KEY = process.env.MOCK_KEY || "";

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startMockServer({ port: PORT, cert: CERT, key: KEY, logFile: LOG_FILE }).then((server) => {
    const address = server.address();
    console.log(`mock listening on https://127.0.0.1:${address.port}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export function startMockServer({ port = 9443, cert, key, logFile = "" } = {}) {
  if (!cert || !key) {
    return Promise.reject(new Error("MOCK_CERT and MOCK_KEY are required."));
  }

  const options = {
    cert: fs.readFileSync(cert),
    key: fs.readFileSync(key)
  };

  const server = https.createServer(options, (req, res) => {
    handleRequest(req, res, logFile);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function logRequest(logFile, entry) {
  const line = JSON.stringify(entry);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${line}\n`);
    } catch {
      // Test logging is best effort.
    }
  }
  // Keep stdout useful when running standalone.
  if (!logFile) {
    console.log(line);
  }
}

async function handleRequest(req, res, logFile) {
  const url = new URL(req.url, `https://${req.headers.host || "opencode.ai"}`);
  const body = await readBody(req);
  let parsed = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }

  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  if (host !== "opencode.ai") {
    serveStatic(req, res, url);
    return;
  }

  logRequest(logFile, {
    ts: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    headers: {
      authorization: req.headers.authorization || null,
      session: req.headers["x-opencode-session"] || null,
      userAgent: req.headers["user-agent"] || null,
      origin: req.headers.origin || null,
      accept: req.headers.accept || null,
      contentType: req.headers["content-type"] || null,
      anthropicVersion: req.headers["anthropic-version"] || null
    },
    body: parsed
  });

  if (req.method === "GET" && (url.pathname === "/inference/v1/models" || url.pathname === "/inference/go/v1/models")) {
    sendJson(res, 200, {
      object: "list",
      data: [
        { id: "mock-stream", object: "model" },
        { id: "mock-echo", object: "model" },
        { id: "mock-slow", object: "model" },
        { id: "mock-first-byte", object: "model" }
      ]
    });
    return;
  }

  const isAnthropic = url.pathname.endsWith("/anthropic/v1/messages");
  if (req.method !== "POST" || (!isAnthropic && !/\/(chat\/completions|responses)$/.test(url.pathname))) {
    sendJson(res, 404, { error: { message: "mock: not found", type: "not_found" } });
    return;
  }

  const model = String(parsed?.model || "");
  const status = Number(parsed?.mock_status || 0);
  if (model === "mock-error" || status) {
    const code = status || 429;
    const headers = { "content-type": "application/json", "x-request-id": "mock-error" };
    if (code === 429) headers["retry-after"] = "2";
    res.writeHead(code, headers);
    res.end(JSON.stringify({ error: { message: "mock upstream error", type: "mock_error", code } }));
    return;
  }

  const isResponses = url.pathname.endsWith("/responses");
  const delayMs = Number(parsed?.mock_delay_ms || 0);
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  if (model === "mock-slow" || model === "mock-cancel") {
    streamMock(req, res, { model, isResponses, isAnthropic });
    return;
  }

  if (model === "mock-first-byte") {
    await sleep(Number(parsed?.mock_delay_ms || 35000));
    streamMock(req, res, { model, isResponses, isAnthropic });
    return;
  }

  if (model === "mock-utf8") {
    streamUtf8(req, res, isResponses, isAnthropic);
    return;
  }

  if (model === "mock-stream" || parsed?.stream === true) {
    streamMock(req, res, { model, isResponses, isAnthropic });
    return;
  }

  sendJson(res, 200, responseBody(req, url, parsed, isResponses, isAnthropic));
}

function responseBody(req, url, body, isResponses, isAnthropic) {
  const text = isResponses
    ? String(body?.input ?? "")
    : String(body?.messages?.at(-1)?.content ?? "");
  if (isAnthropic) {
    return {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: body?.model || "mock-echo",
      content: [{ type: "text", text: `mock:${text}` }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: text.length,
        output_tokens: 5,
        cost: 0,
        opencode: { billing_source: "go", allowance: 0.0001 }
      }
    };
  }
  if (isResponses) {
    return {
      id: "resp_mock",
      object: "response",
      model: body?.model || "mock-echo",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `mock:${text}` }] }],
      usage: { input_tokens: text.length, output_tokens: 5, total_tokens: text.length + 5, cost: 0, opencode: { billing_source: "go", allowance: 0.0001 } }
    };
  }
  return {
    id: "chatcmpl_mock",
    object: "chat.completion",
    model: body?.model || "mock-echo",
    choices: [{ index: 0, message: { role: "assistant", content: `mock:${text}` }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: text.length,
      completion_tokens: 5,
      total_tokens: text.length + 5,
      cost: 0,
      opencode: { billing_source: "go", allowance: 0.0001 }
    }
  };
}

function streamMock(req, res, { model, isResponses, isAnthropic }) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-request-id": `mock-${model}`,
    "x-mock-session": "mock"
  });
  res.flushHeaders?.();

  let closed = false;
  req.on("close", () => { closed = true; });

  const pieces = ["he", "llo", " ", "world"];
  let index = 0;
  const timer = setInterval(() => {
    if (closed || res.writableEnded) {
      clearInterval(timer);
      return;
    }
    if (model === "mock-cancel") {
      writeEvent(res, eventPayload(isResponses, "tick", ".", isAnthropic));
      return;
    }
    if (index < pieces.length) {
      const text = pieces[index++];
      writeEvent(res, eventPayload(isResponses, "delta", text, isAnthropic));
      return;
    }
    res.write(isAnthropic
      ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      : "data: [DONE]\n\n");
    clearInterval(timer);
    res.end();
  }, 150);

  res.on("close", () => {
    closed = true;
    clearInterval(timer);
  });
}

function streamUtf8(req, res, isResponses, isAnthropic) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-request-id": "mock-utf8"
  });
  res.flushHeaders?.();

  // Deliberately split the UTF-8 bytes of this SSE frame at awkward
  // boundaries so the extension's streaming TextDecoder is exercised.
  const payload = eventPayload(isResponses, "delta", "你好🙂", isAnthropic);
  const eventPrefix = isAnthropic ? `event: ${payload.type}\n` : "";
  const frame = Buffer.from(`${eventPrefix}data: ${JSON.stringify(payload)}\n\n`, "utf8");
  const sizes = [1, 2, 1, 3, 2, 1, 4, 2, 1];
  let offset = 0;
  let closed = false;
  req.on("close", () => { closed = true; });

  const timer = setInterval(() => {
    if (closed || res.writableEnded) {
      clearInterval(timer);
      return;
    }
    if (offset >= frame.length) {
      res.write(isAnthropic
        ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        : "data: [DONE]\n\n");
      clearInterval(timer);
      res.end();
      return;
    }
    const size = sizes[Math.floor(Math.random() * sizes.length)] || 1;
    const end = Math.min(frame.length, offset + size);
    res.write(frame.subarray(offset, end));
    offset = end;
  }, 30);

  res.on("close", () => {
    closed = true;
    clearInterval(timer);
  });
}

function writeEvent(res, payload) {
  const prefix = payload.type === "content_block_delta" ? `event: ${payload.type}\n` : "";
  res.write(`${prefix}data: ${JSON.stringify(payload)}\n\n`);
}

function eventPayload(isResponses, kind, text, isAnthropic) {
  if (isAnthropic) {
    return {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text }
    };
  }
  if (isResponses) {
    return {
      type: kind === "tick" ? "response.output_text.delta" : "response.output_text.delta",
      delta: text,
      response_id: "resp_mock"
    };
  }
  return {
    id: "chatcmpl_mock",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
  };
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname === "/demo" || pathname === "/demo/") {
    pathname = "/demo/index.html";
  } else if (pathname.endsWith("/")) {
    pathname = `${pathname}index.html`;
  }

  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "content-length": data.length
    });
    if (req.method === "HEAD") res.end();
    else res.end(data);
  });
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "x-request-id": "mock-json"
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
