// External-web-page tests. CDP Fetch interception serves the page, SDK, and
// test script from memory, so this works even when the environment blocks
// renderer network access. The extension still performs its real
// externally_connectable + Origin allowlist checks.
//
// Run against Chromium with the extension loaded:
//   node tests/browser/external-page-test.mjs <cdpPort>

import fs from "node:fs";
import { listTargets, createTarget, connectTarget, sleep } from "./cdp.mjs";

const port = Number(process.argv[2] || 9487);
const projectRoot = new URL("../../", import.meta.url);
const sdkSource = fs.readFileSync(new URL("sdk/opencode-bridge.js", projectRoot), "utf8");

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

const swCdp = await connectTarget(sw);
await swCdp.send("Runtime.enable");

// Configure the extension: only https://demo.test is allowed.
const optionsTarget = await createTarget(port, "about:blank");
const options = await connectTarget(optionsTarget);
await options.send("Runtime.enable");
await options.send("Page.enable");
await options.send("Page.navigate", { url: `chrome-extension://${extensionId}/options/index.html` });
await sleep(800);
await options.evaluate(`
  document.getElementById('provider').value = 'go';
  document.getElementById('clientUserAgent').value = 'ocb-external-test/1.0';
  document.getElementById('allowedOrigins').value = 'https://demo.test';
  document.getElementById('apiKey').value = 'oc_sk_external_test';
  document.getElementById('save').click();
  'clicked'
`);
await sleep(1000);
console.log("OPTIONS_SAVED");

// Pre-create offscreen and install the same controllable fetch stub.
await swCdp.evaluate(`
  chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['WORKERS'],
    justification: 'external page test'
  }).then(() => 'created').catch(e => 'ERR:' + e.message)
`);
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
await offscreen.evaluate(`(${setStubConfig.toString()})(${JSON.stringify({ mode: "stream", frames: ["hello", " ", "world"] })})`);
console.log("OFFSCREEN_STUBBED");

const pageJs = `
(async () => {
  try {
    const mod = await import('/sdk/opencode-bridge.js');
    const bridge = new mod.OpenCodeBridge({ extensionId: ${JSON.stringify(extensionId)} });
    const conversation = bridge.createConversation({ sessionId: 'ses_external_test' });
    const stream = await conversation.chat.completions.create({
      model: 'mock-stream',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    self.__result = {
      origin: location.origin,
      chunks: chunks.map(c => c?.choices?.[0]?.delta?.content || '').join(''),
      storageType: typeof chrome.storage
    };
  } catch (e) {
    self.__result = {
      origin: location.origin,
      error: { code: e.code, message: e.message }
    };
  }
})();
`;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>bridge external test</title></head>
<body><script type="module" src="/test.js"></script></body></html>`;

async function runPage(host, expected) {
  console.log("RUN_PAGE", host);
  const target = await createTarget(port, "about:blank");
  const cdp = await connectTarget(target);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  console.log("FETCH_ENABLED", host);

  let sawPause = false;
  cdp.on("Fetch.requestPaused", async (params) => {
    sawPause = true;
    const url = params.request.url;
    const path = new URL(url).pathname;
    console.log("FETCH_PAUSED", host, path);
    const body = path === "/test.html"
      ? html
      : path === "/test.js"
        ? pageJs
        : path === "/sdk/opencode-bridge.js"
          ? sdkSource
          : null;

    try {
      if (path === "/favicon.ico") {
        await cdp.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 204,
          responseHeaders: []
        });
        return;
      }
      if (body !== null) {
        await cdp.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{
            name: "content-type",
            value: path.endsWith(".html")
              ? "text/html; charset=utf-8"
              : "text/javascript; charset=utf-8"
          }],
          body: Buffer.from(body, "utf8").toString("base64")
        });
        return;
      }
      await cdp.send("Fetch.continueRequest", { requestId: params.requestId });
    } catch {
      // Ignore; the target may have closed.
    }
  });

  const url = `https://${host}/test.html`;
  cdp.send("Page.navigate", { url }).catch((error) => console.log("NAV_ERROR", host, error.message));
  console.log("NAV_SENT", host);

  for (let i = 0; i < 25 && !sawPause; i += 1) {
    await sleep(200);
  }
  if (!sawPause) {
    cdp.close();
    throw new Error("environment blocks renderer navigation before CDP Fetch");
  }

  let result = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(200);
    try {
      result = await Promise.race([
        cdp.evaluate("self.__result || null", { awaitPromise: false }),
        sleep(1500).then(() => null)
      ]);
      if (result) break;
    } catch {
      // Renderer may be transitioning.
    }
  }
  console.log("PAGE_RESULT", host, JSON.stringify(result));
  cdp.close();
  return { url, result };
}

try {
  let allowed;
  try {
    allowed = await runPage("demo.test", "allowed");
  } catch (error) {
    if (String(error.message).includes("environment blocks")) {
      console.log("SKIP external page tests: this Chromium environment blocks renderer navigation before CDP Fetch. See RESULTS.md.");
      process.exitCode = 0;
      options.close();
      offscreen.close();
      swCdp.close();
      process.exit(0);
    }
    throw error;
  }
  console.log("ALLOWED", JSON.stringify(allowed.result));
  check("external page loaded with expected origin", allowed.result?.origin === "https://demo.test", JSON.stringify(allowed.result));
  check("external page stream", allowed.result?.chunks === "hello world", JSON.stringify(allowed.result));
  check("external page cannot read chrome.storage", allowed.result?.storageType === "undefined", JSON.stringify(allowed.result));

  const evil = await runPage("evil.test", "denied");
  console.log("EVIL", JSON.stringify(evil.result));
  check("non-allowlisted origin denied", evil.result?.error?.code === "ORIGIN_DENIED", JSON.stringify(evil.result));

  const suffix = await runPage("demo.test.evil", "denied-suffix");
  console.log("SUFFIX", JSON.stringify(suffix.result));
  check("origin suffix bypass denied", suffix.result?.error?.code === "ORIGIN_DENIED", JSON.stringify(suffix.result));
} finally {
  options.close();
  offscreen.close();
  swCdp.close();
}

if (failures > 0) {
  console.error(`${failures} external page test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("All external page tests passed.");
}

function installStub() {
  self.__stubConfig = {};
  self.fetch = async (url, opts = {}) => {
    const config = self.__stubConfig || {};
    self.__lastRequest = { url, headers: opts.headers || {}, body: opts.body };
    const encoder = new TextEncoder();
    const frames = config.frames || ["x"];
    let sent = 0;
    const stream = new ReadableStream({
      start(controller) {
        const timer = setInterval(() => {
          if (sent >= frames.length) {
            controller.enqueue(encoder.encode("data: [DONE]\\n\\n"));
            clearInterval(timer);
            controller.close();
            return;
          }
          const text = frames[sent % frames.length];
          sent += 1;
          controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\\n\\n"));
        }, 40);
      }
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
    try {
      Object.defineProperty(response, "url", { value: url });
    } catch {
      // Ignore.
    }
    return response;
  };
}

function setStubConfig(config) {
  self.__stubConfig = config;
  return "configured";
}
