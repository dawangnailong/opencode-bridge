// Browser integration tests for the bridge protocol, using a stubbed
// offscreen fetch. This exercises the real extension service worker,
// offscreen document, internal trusted port, SDK, SSE parser, and routing
// without depending on outbound network.
//
// Usage: start Chromium with the extension and a CDP port, then:
//   node tests/browser/protocol-test.mjs <cdpPort> [--first-byte] [--long]

import { listTargets, createTarget, connectTarget, sleep } from "./cdp.mjs";

const port = Number(process.argv[2] || 9480);
const runFirstByte = process.argv.includes("--first-byte");
const runLong = process.argv.includes("--long");

let failures = 0;
function check(name, condition, extra = "") {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`);
  }
}

const targets = await listTargets(port);
const sw = targets.find((t) => t.type === "service_worker" && t.url.includes("/background/service-worker.js"));
if (!sw) throw new Error("Extension service worker target not found.");
const extensionId = new URL(sw.url).host;
console.log("EXTENSION_ID", extensionId);

const swCdp = await connectTarget(sw);
await swCdp.send("Runtime.enable");

// Configure the extension through its real options page.
const optionsTarget = await createTarget(port, "about:blank");
const options = await connectTarget(optionsTarget);
await options.send("Runtime.enable");
await options.send("Page.enable");
await options.send("Page.navigate", { url: `chrome-extension://${extensionId}/options/index.html` });
await sleep(800);
await options.evaluate(`
  document.getElementById('provider').value = 'go';
  document.getElementById('clientUserAgent').value = 'ocb-browser-test/1.0';
  document.getElementById('allowedOrigins').value = 'https://demo.test';
  document.getElementById('apiKey').value = 'oc_sk_browser_test';
  document.getElementById('save').click();
  'clicked'
`);
await options.waitFor(async () => {
  const text = await options.evaluate('document.getElementById("status").textContent');
  return text.includes("saved");
}, 5000);

// Pre-create the offscreen executor and install a controllable fetch stub.
const created = await swCdp.evaluate(`
  chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['WORKERS'],
    justification: 'browser protocol test'
  }).then(() => 'created').catch(e => 'ERR:' + e.message)
`);
check("offscreen created", created === "created", created);

let offscreenTarget = null;
for (let i = 0; i < 30; i += 1) {
  await sleep(200);
  const list = await listTargets(port);
  offscreenTarget = list.find((t) => t.url.includes("offscreen/offscreen.html"));
  if (offscreenTarget) break;
}
if (!offscreenTarget) throw new Error("Offscreen target not found.");
const offscreen = await connectTarget(offscreenTarget);
await offscreen.send("Runtime.enable");
await offscreen.evaluate(`(${installStub.toString()})()`);

async function setStub(config) {
  await offscreen.evaluate(`(${setStubConfig.toString()})(${JSON.stringify(config)})`);
}

// Load the real SDK in the trusted options page and connect through the
// extension-internal port.
await options.evaluate(`
  (async () => {
    const mod = await import('/sdk/opencode-bridge.js');
    self.__bridge = new mod.OpenCodeBridge({ extensionId: chrome.runtime.id });
    self.__conversation = self.__bridge.createConversation({ sessionId: 'ses_browser_test' });
    await self.__bridge.connect();
    return 'ready';
  })()
`);

const sessionId = await options.evaluate("self.__conversation.sessionId");

// 1. Chat Completions stream.
await setStub({ mode: "stream", frames: ["he", "llo", " world"] });
const chatChunks = await options.evaluate(`
  (async () => {
    const stream = await self.__conversation.chat.completions.create({
      model: 'mock-stream',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true
    });
    const out = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
  })()
`);
const chatText = chatChunks.map((c) => c?.choices?.[0]?.delta?.content || "").join("");
check("chat stream text", chatText === "hello world", chatText);
check("chat stream chunk count", chatChunks.length === 3, String(chatChunks.length));

const last = await offscreen.evaluate("self.__lastRequest");
check("authorization injected", last?.headers?.Authorization === "Bearer oc_sk_browser_test", JSON.stringify(last?.headers));
check("session header", last?.headers?.["x-opencode-session"] === "ses_browser_test", JSON.stringify(last?.headers));
check("session matches SDK", sessionId === "ses_browser_test", sessionId);
check("stream accept header", last?.headers?.Accept === "text/event-stream", JSON.stringify(last?.headers));
check("body passed through", String(last?.body || "").includes('"model":"mock-stream"'), String(last?.body));

// 2. Non-stream JSON.
await setStub({ mode: "json" });
const nonStream = await options.evaluate(`
  (async () => {
    const r = await self.__conversation.chat.completions.create({
      model: 'mock-echo',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false
    });
    return { status: r.status, json: r.json };
  })()
`);
check("non-stream status", nonStream.status === 200, JSON.stringify(nonStream));
check("non-stream json", nonStream.json?.ok === true, JSON.stringify(nonStream));

// 3. Upstream error status/header passthrough.
await setStub({ mode: "error" });
const errorResult = await options.evaluate(`
  (async () => {
    try {
      await self.__conversation.chat.completions.create({
        model: 'mock-error', messages: [], stream: false
      });
      return { none: true };
    } catch (e) {
      return {
        code: e.code,
        status: e.status,
        message: e.message,
        retry: e.headers && e.headers['retry-after']
      };
    }
  })()
`);
check("upstream error code", errorResult.code === "UPSTREAM_HTTP_ERROR", JSON.stringify(errorResult));
check("upstream error status", errorResult.status === 429, JSON.stringify(errorResult));
check("retry-after passthrough", errorResult.retry === "2", JSON.stringify(errorResult));

// 4. Responses API stream.
await setStub({ mode: "stream", responses: true, frames: ["A", "B"] });
const responsesChunks = await options.evaluate(`
  (async () => {
    const stream = await self.__conversation.responses.create({
      model: 'mock-stream', input: 'hi', stream: true
    });
    const out = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
  })()
`);
const responsesText = responsesChunks.map((c) => c?.delta || "").join("");
check("responses stream text", responsesText === "AB", responsesText);

// 5. Cancellation.
await setStub({ mode: "endless", intervalMs: 50 });
const cancelPromise = options.evaluate(`
  (async () => {
    const controller = new AbortController();
    const stream = await self.__conversation.chat.completions.create({
      model: 'mock-cancel', messages: [], stream: true
    }, { signal: controller.signal });
    let count = 0;
    try {
      for await (const chunk of stream) {
        count += 1;
        if (count >= 2) controller.abort();
      }
      return { done: true, count };
    } catch (e) {
      return { code: e.code, count };
    }
  })()
`);
const cancelResult = await cancelPromise;
check("cancel code", cancelResult.code === "ABORTED", JSON.stringify(cancelResult));
check("cancel after chunks", cancelResult.count >= 2, JSON.stringify(cancelResult));
const stubCancelled = await offscreen.evaluate("!!self.__stubCancelled");
check("offscreen stream cancelled", stubCancelled === true, String(stubCancelled));

if (runFirstByte) {
  console.log("Running first-byte-delay test (35s)...");
  await setStub({ mode: "stream", delayMs: 35000, frames: ["late"] });
  const late = await options.evaluate(`
    (async () => {
      const stream = await self.__conversation.chat.completions.create({
        model: 'mock-first-byte', messages: [], stream: true
      });
      const out = [];
      for await (const chunk of stream) out.push(chunk);
      return out.map(c => c?.choices?.[0]?.delta?.content || '').join('');
    })()
  `);
  check("first-byte delay completes via offscreen", late === "late", late);
}

if (runLong) {
  const durationMs = 6 * 60 * 1000;
  console.log(`Running long stream test (${durationMs / 60000} min)...`);
  await setStub({ mode: "long", durationMs, intervalMs: 1000, frames: ["."] });
  const started = Date.now();
  const result = await options.evaluate(`
    (async () => {
      const stream = await self.__conversation.chat.completions.create({
        model: 'mock-slow', messages: [], stream: true
      });
      let count = 0;
      for await (const chunk of stream) count += 1;
      return count;
    })()
  `);
  const elapsed = Date.now() - started;
  check("long stream > 5 minutes", elapsed > 5 * 60 * 1000 && result > 0, `elapsed=${elapsed} chunks=${result}`);
}

try {
  await swCdp.evaluate("chrome.offscreen.closeDocument().then(() => 'closed').catch(e => 'ERR:' + e.message)");
} catch {
  // Ignore cleanup errors.
}
options.close();
offscreen.close();
swCdp.close();

if (failures > 0) {
  console.error(`${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("All browser protocol tests passed.");
}

// Installed once in the offscreen document.
function installStub() {
  self.__stubConfig = {};
  self.__stubInstalled = true;
  self.fetch = async (url, opts = {}) => {
    const config = self.__stubConfig || {};
    self.__lastRequest = { url, headers: opts.headers || {}, body: opts.body };
    if (config.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    }
    if (config.mode === "error") {
      return makeResponse(JSON.stringify({ error: { message: "mock rate limit" } }), 429, {
        "content-type": "application/json",
        "retry-after": "2",
        "x-request-id": "stub-429"
      }, url);
    }
    if (config.mode === "json") {
      return makeResponse(JSON.stringify({ ok: true, url }), 200, {
        "content-type": "application/json",
        "x-request-id": "stub-json"
      }, url);
    }

    const encoder = new TextEncoder();
    const frames = config.frames || ["he", "llo", " world"];
    const interval = config.intervalMs || 40;
    const durationMs = config.durationMs || 0;
    const endless = config.mode === "endless" || config.mode === "long";
    let sent = 0;
    let timer = null;

    const stream = new ReadableStream({
      start(controller) {
        if (opts.signal) {
          const onAbort = () => {
            if (timer) clearInterval(timer);
            self.__stubCancelled = true;
            try {
              controller.error(new DOMException("Aborted", "AbortError"));
            } catch {
              // Ignore.
            }
          };
          if (opts.signal.aborted) onAbort();
          else opts.signal.addEventListener("abort", onAbort, { once: true });
        }

        const startedAt = Date.now();
        timer = setInterval(() => {
          const elapsed = Date.now() - startedAt;
          if (durationMs && elapsed >= durationMs) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            clearInterval(timer);
            controller.close();
            return;
          }
          if (!endless && !durationMs && sent >= frames.length) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            clearInterval(timer);
            controller.close();
            return;
          }
          const text = frames[sent % frames.length];
          sent += 1;
          const payload = config.responses
            ? { type: "response.output_text.delta", delta: text }
            : { choices: [{ delta: { content: text } }] };
          controller.enqueue(encoder.encode("data: " + JSON.stringify(payload) + "\n\n"));
        }, interval);
      },
      cancel() {
        if (timer) clearInterval(timer);
        self.__stubCancelled = true;
      }
    });

    return makeResponse(stream, 200, {
      "content-type": "text/event-stream",
      "x-request-id": "stub-stream"
    }, url);
  };

  function makeResponse(body, status, headers, url) {
    const response = new Response(body, { status, headers });
    try {
      Object.defineProperty(response, "url", { value: url });
    } catch {
      // Ignore.
    }
    return response;
  }
}

// Runs in the offscreen document for each scenario.
function setStubConfig(config) {
  self.__stubConfig = config;
  self.__stubCancelled = false;
  return "configured";
}
