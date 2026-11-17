import { OpenCodeBridge } from "../sdk/opencode-bridge.js";

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "opencode-bridge-demo";
const MAX_RAW_CHARS = 120000;

let bridge = null;
let conversation = null;
let controller = null;

document.addEventListener("DOMContentLoaded", () => {
  restore();
  $("send").addEventListener("click", () => void send());
  $("cancel").addEventListener("click", cancel);
  $("newConversation").addEventListener("click", () => {
    if (resetConversation()) {
      setStatus("New conversation.");
    }
  });
  $("modelsButton").addEventListener("click", () => void listModels());
  $("extensionId").addEventListener("change", () => {
    save();
    resetBridge();
  });
  $("api").addEventListener("change", () => {
    $("model").value = $("model").value || "kimi-k3";
  });
});

function restore() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    saved = {};
  }
  $("extensionId").value = saved.extensionId || "";
  $("model").value = saved.model || "kimi-k3";
  $("api").value = saved.api || "chat";
  $("stream").checked = saved.stream !== false;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      extensionId: $("extensionId").value.trim(),
      model: $("model").value.trim(),
      api: $("api").value,
      stream: $("stream").checked
    }));
  } catch {
    // localStorage may be unavailable; not fatal.
  }
}

function getBridge() {
  const extensionId = $("extensionId").value.trim();
  if (!extensionId) {
    throw new Error("Paste the extension ID first.");
  }
  if (!bridge || bridge.extensionId !== extensionId) {
    bridge?.close();
    bridge = new OpenCodeBridge({ extensionId });
  }
  if (!conversation) {
    conversation = bridge.createConversation();
    $("sessionId").value = conversation.sessionId;
  }
  return { bridge, conversation };
}

function resetBridge() {
  bridge?.close();
  bridge = null;
  conversation = null;
  $("sessionId").value = "";
  setBadge("not connected", false);
}

function resetConversation() {
  try {
    const { bridge: b } = getBridge();
    conversation = b.createConversation();
    $("sessionId").value = conversation.sessionId;
    return true;
  } catch (error) {
    conversation = null;
    $("sessionId").value = "";
    setStatus(error?.message || "Bridge is not ready.", true);
    return false;
  }
}

function setStatus(message, isError = false) {
  const el = $("status");
  el.textContent = message || "";
  el.classList.toggle("error", Boolean(isError));
  el.classList.toggle("ok", Boolean(message) && !isError);
}

function setBadge(text, connected) {
  const el = $("connectionBadge");
  el.textContent = text;
  el.classList.toggle("connected", connected);
}

function setBusy(busy) {
  $("send").disabled = busy;
  $("cancel").disabled = !busy;
  $("modelsButton").disabled = busy;
}

function cancel() {
  controller?.abort();
}

async function send() {
  save();
  const prompt = $("prompt").value.trim();
  if (!prompt) {
    setStatus("Write a prompt first.", true);
    return;
  }

  let ctx;
  try {
    ctx = getBridge();
  } catch (error) {
    setStatus(error?.message || "Bridge is not ready.", true);
    return;
  }

  const model = $("model").value.trim();
  if (!model) {
    setStatus("Set a model ID first.", true);
    return;
  }

  const api = $("api").value;
  const stream = $("stream").checked;
  const body = api === "chat"
    ? { model, messages: [{ role: "user", content: prompt }], stream }
    : { model, input: prompt, stream };

  $("output").textContent = "";
  $("raw").textContent = "";
  $("usage").textContent = "";
  setStatus("Connecting...");
  setBusy(true);
  setBadge("connecting", false);

  controller = new AbortController();
  const { conversation: currentConversation } = ctx;

  try {
    if (stream) {
      const streamResult = api === "chat"
        ? await currentConversation.chat.completions.create(body, {
            signal: controller.signal,
            onEvent: appendRaw
          })
        : await currentConversation.responses.create(body, {
            signal: controller.signal,
            onEvent: appendRaw
          });

      setBadge("streaming", true);
      setStatus("Streaming. Press Cancel to stop.");

      for await (const chunk of streamResult) {
        appendChunk(api, chunk);
      }

      setStatus("Done.");
      setBadge("connected", true);
    } else {
      const response = api === "chat"
        ? await currentConversation.chat.completions.create(body, { signal: controller.signal })
        : await currentConversation.responses.create(body, { signal: controller.signal });

      const value = response.json ?? response.body ?? "";
      $("output").textContent = typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2);
      showUsage(response.json);
      setStatus(`HTTP ${response.status}`);
      setBadge("connected", true);
    }
  } catch (error) {
    if (error?.code === "ABORTED") {
      setStatus("Cancelled.");
    } else {
      const parts = [
        error?.code || "ERROR",
        error?.status ? `HTTP ${error.status}` : "",
        error?.message || String(error)
      ].filter(Boolean);
      setStatus(parts.join(" — "), true);
      if (error?.body) {
        $("output").textContent = typeof error.body === "string"
          ? error.body
          : JSON.stringify(error.body, null, 2);
      }
    }
    setBadge("error", false);
  } finally {
    controller = null;
    setBusy(false);
  }
}

function appendChunk(api, chunk) {
  if (!chunk || typeof chunk !== "object") {
    if (typeof chunk === "string" && chunk) appendText(chunk);
    return;
  }

  if (api === "chat") {
    const text = chunk?.choices?.[0]?.delta?.content;
    if (typeof text === "string" && text) appendText(text);
    showUsage(chunk);
    return;
  }

  if (chunk.type === "response.output_text.delta" && typeof chunk.delta === "string") {
    appendText(chunk.delta);
  } else if (chunk.type === "response.completed") {
    showUsage(chunk.response);
  } else if (chunk.usage) {
    showUsage(chunk);
  }
}

function appendText(text) {
  $("output").textContent += text;
  $("output").scrollTop = $("output").scrollHeight;
}

function appendRaw(event) {
  const raw = $("raw");
  if (raw.textContent.length > MAX_RAW_CHARS) {
    raw.textContent = raw.textContent.slice(-MAX_RAW_CHARS);
  }
  raw.textContent += `${JSON.stringify(event)}\n`;
  raw.scrollTop = raw.scrollHeight;
}

function showUsage(value) {
  const usage = value?.usage || value?.response?.usage;
  if (!usage) return;
  const cost = usage.opencode?.cost;
  const allowance = usage.opencode?.allowance;
  const pieces = [];
  if (usage.total_tokens != null) pieces.push(`${usage.total_tokens} tokens`);
  if (usage.prompt_tokens != null) pieces.push(`${usage.prompt_tokens} in`);
  if (usage.completion_tokens != null) pieces.push(`${usage.completion_tokens} out`);
  if (cost != null) pieces.push(`$${cost}`);
  if (allowance != null) pieces.push(`Go allowance $${allowance}`);
  $("usage").textContent = pieces.join(" · ");
}

async function listModels() {
  let ctx;
  try {
    ctx = getBridge();
  } catch (error) {
    setStatus(error?.message || "Bridge is not ready.", true);
    return;
  }

  setBusy(true);
  setStatus("Fetching models...");
  try {
    const response = await ctx.bridge.models.list();
    const value = response.json ?? response.body ?? "";
    $("output").textContent = typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
    setStatus(`HTTP ${response.status}`);
    setBadge("connected", true);
  } catch (error) {
    setStatus(`${error?.code || "ERROR"} — ${error?.message || String(error)}`, true);
    setBadge("error", false);
  } finally {
    setBusy(false);
  }
}
