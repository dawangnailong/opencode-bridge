// Failure/recovery tests for the offscreen executor and service worker.
// Run against a Chromium instance with the extension loaded:
//   node tests/browser/failure-test.mjs <cdpPort>

import { CDP, listTargets, createTarget, connectTarget, sleep } from "./cdp.mjs";

const port = Number(process.argv[2] || 9486);
let failures = 0;
const check = (name, condition, extra = "") => {
  if (condition) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`);
  }
};

const targets = await listTargets(port);
const sw = targets.find((t) => t.type === "service_worker" && t.url.includes("/background/service-worker.js"));
if (!sw) throw new Error("Extension service worker target not found.");
const extensionId = new URL(sw.url).host;
console.log("EXTENSION_ID", extensionId);

const swCdp = await connectTarget(sw);
await swCdp.send("Runtime.enable");

const optionsTarget = await createTarget(port, "about:blank");
const options = await connectTarget(optionsTarget);
await options.send("Runtime.enable");
await options.send("Page.enable");
await options.send("Page.navigate", { url: `chrome-extension://${extensionId}/options/index.html` });
await sleep(800);
await options.evaluate(`
  document.getElementById('provider').value = 'go';
  document.getElementById('clientUserAgent').value = 'ocb-failure-test/1.0';
  document.getElementById('allowedOrigins').value = '';
  document.getElementById('apiKey').value = 'oc_sk_failure_test';
  document.getElementById('save').click();
  'clicked'
`);
await options.waitFor(async () => (await options.evaluate('document.getElementById("status").textContent')).includes("saved"), 5000);

await options.evaluate(`
  (async () => {
    const mod = await import('/sdk/opencode-bridge.js');
    self.__bridge = new mod.OpenCodeBridge({ extensionId: chrome.runtime.id });
    self.__conversation = self.__bridge.createConversation({ sessionId: 'ses_failure_test' });
    await self.__bridge.connect();
    return 'ready';
  })()
`);

async function createOffscreen() {
  const created = await swCdp.evaluate(`
    chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'browser failure test'
    }).then(() => 'created').catch(e => 'ERR:' + e.message)
  `);
  const existing = /single offscreen|already exists|more than one offscreen/i.test(created);
  if (created !== "created" && !existing) {
    return { created, offscreen: null };
  }
  let offscreenTarget = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(200);
    const list = await listTargets(port);
    offscreenTarget = list.find((t) => t.url.includes("offscreen/offscreen.html"));
    if (offscreenTarget) break;
  }
  if (!offscreenTarget) return { created, offscreen: null };
  const offscreen = await connectTarget(offscreenTarget);
  await offscreen.send("Runtime.enable");
  await offscreen.evaluate(`(${installStub.toString()})()`);
  return { created: created === "created" ? "created" : "existing", offscreen };
}

async function setStub(offscreen, config) {
  await offscreen.evaluate(`(${setStubConfig.toString()})(${JSON.stringify(config)})`);
}

// --- Offscreen failure -----------------------------------------------------
const first = await createOffscreen();
check("offscreen available", first.created === "created" || first.created === "existing", first.created);
if (!first.offscreen) throw new Error("Could not create offscreen.");
await setStub(first.offscreen, { mode: "endless", intervalMs: 50 });

await options.evaluate(`
  self.__chunks = 0; self.__err = null; self.__done = false;
  (async () => {
    try {
      const stream = await self.__conversation.chat.completions.create({
        model: 'mock-cancel', messages: [], stream: true
      });
      for await (const chunk of stream) self.__chunks += 1;
      self.__done = true;
    } catch (e) {
      self.__err = { code: e.code, message: e.message };
      self.__done = true;
    }
  })();
  'started'
`, { awaitPromise: false });

await options.waitFor(async () => (await options.evaluate("self.__chunks")) >= 2, 5000);
check("stream active before offscreen close", (await options.evaluate("self.__chunks")) >= 2);
const closed = await swCdp.evaluate("chrome.offscreen.closeDocument().then(() => 'closed').catch(e => 'ERR:' + e.message)");
check("offscreen close requested", closed === "closed", closed);
await options.waitFor(async () => await options.evaluate("self.__done"), 5000);
const offscreenError = await options.evaluate("self.__err");
check("offscreen failure code", offscreenError?.code === "OFFSCREEN_DISCONNECTED", JSON.stringify(offscreenError));

// Recreate and verify the next request works.
const second = await createOffscreen();
check("offscreen recreated", second.created === "created" || second.created === "existing", second.created);
if (!second.offscreen) throw new Error("Could not recreate offscreen.");
await setStub(second.offscreen, { mode: "stream", frames: ["again"] });
const recovered = await options.evaluate(`
  (async () => {
    const stream = await self.__conversation.chat.completions.create({
      model: 'mock-stream', messages: [], stream: true
    });
    const out = [];
    for await (const chunk of stream) out.push(chunk);
    return out.map(c => c?.choices?.[0]?.delta?.content || '').join('');
  })()
`);
check("request recovers after offscreen recreate", recovered === "again", recovered);

// --- Service worker stop ---------------------------------------------------
await setStub(second.offscreen, { mode: "endless", intervalMs: 50 });
await options.evaluate(`
  self.__chunks = 0; self.__err = null; self.__done = false;
  (async () => {
    try {
      const stream = await self.__conversation.chat.completions.create({
        model: 'mock-cancel', messages: [], stream: true
      });
      for await (const chunk of stream) self.__chunks += 1;
      self.__done = true;
    } catch (e) {
      self.__err = { code: e.code, message: e.message };
      self.__done = true;
    }
  })();
  'started'
`, { awaitPromise: false });
await options.waitFor(async () => (await options.evaluate("self.__chunks")) >= 2, 5000);

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = new CDP(version.webSocketDebuggerUrl);
await browser.connect();
const closeResult = await browser.send("Target.closeTarget", { targetId: sw.id }).catch((e) => ({ error: e.message }));
console.log("SW_CLOSE", JSON.stringify(closeResult));
browser.close();

await options.waitFor(async () => await options.evaluate("self.__done"), 8000).catch(() => false);
const swError = await options.evaluate("self.__err");
check("service worker stop surfaces error", swError?.code === "SW_DISCONNECTED" || swError?.code === "OFFSCREEN_DISCONNECTED", JSON.stringify(swError));

try {
  await swCdp.evaluate("chrome.offscreen.closeDocument().then(() => 'closed').catch(e => 'ERR:' + e.message)");
} catch {
  // The service worker may have been stopped by the test.
}
options.close();
second.offscreen?.close();
swCdp.close();

if (failures > 0) {
  console.error(`${failures} failure test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("All failure tests passed.");
}

function installStub() {
  self.__stubConfig = {};
  self.fetch = async (url, opts = {}) => {
    const config = self.__stubConfig || {};
    self.__lastRequest = { url, headers: opts.headers || {}, body: opts.body };
    if (config.mode === "json") {
      return makeResponse(JSON.stringify({ ok: true }), 200, { "content-type": "application/json" }, url);
    }
    const encoder = new TextEncoder();
    const frames = config.frames || ["x"];
    const interval = config.intervalMs || 40;
    const endless = config.mode === "endless";
    let sent = 0;
    let timer = null;
    const stream = new ReadableStream({
      start(controller) {
        if (opts.signal) {
          const onAbort = () => {
            if (timer) clearInterval(timer);
            try { controller.error(new DOMException("Aborted", "AbortError")); } catch {}
          };
          if (opts.signal.aborted) onAbort();
          else opts.signal.addEventListener("abort", onAbort, { once: true });
        }
        timer = setInterval(() => {
          if (!endless && sent >= frames.length) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            clearInterval(timer);
            controller.close();
            return;
          }
          const text = frames[sent % frames.length];
          sent += 1;
          controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n"));
        }, interval);
      },
      cancel() {
        if (timer) clearInterval(timer);
      }
    });
    return makeResponse(stream, 200, { "content-type": "text/event-stream" }, url);
  };
  function makeResponse(body, status, headers, url) {
    const response = new Response(body, { status, headers });
    try { Object.defineProperty(response, "url", { value: url }); } catch {}
    return response;
  }
}

function setStubConfig(config) {
  self.__stubConfig = config;
  return "configured";
}
