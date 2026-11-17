import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeBridge } from "../sdk/opencode-bridge.js";

function installFakeExtension(mode = "stream") {
  const requests = [];
  const messageListeners = [];
  const disconnectListeners = [];

  const port = {
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
      }
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      }
    },
    postMessage(message) {
      if (message.type === "hello") {
        queueMicrotask(() => emit({ type: "hello", protocolVersion: 1, extensionId: "test-extension" }));
        return;
      }

      if (message.type === "ping") {
        queueMicrotask(() => emit({ type: "pong" }));
        return;
      }

      if (message.type === "cancel") {
        queueMicrotask(() => emit({ type: "cancelled", requestId: message.requestId }));
        return;
      }

      if (message.type === "request") {
        requests.push(message);
        if (mode === "error") {
          queueMicrotask(() => emit({
            type: "error",
            requestId: message.requestId,
            error: {
              code: "UPSTREAM_HTTP_ERROR",
              message: "bad request",
              status: 400,
              body: "{\"error\":\"bad\"}"
            }
          }));
          return;
        }

        if (mode === "stream") {
          queueMicrotask(() => emit({ type: "accepted", requestId: message.requestId, status: 200, headers: {} }));
          queueMicrotask(() => emit({
            type: "chunk",
            requestId: message.requestId,
            data: "data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n"
          }));
          queueMicrotask(() => emit({
            type: "chunk",
            requestId: message.requestId,
            data: "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}\n\n"
          }));
          queueMicrotask(() => emit({ type: "chunk", requestId: message.requestId, data: "data: [DONE]\n\n" }));
          queueMicrotask(() => emit({ type: "done", requestId: message.requestId }));
          return;
        }

        queueMicrotask(() => emit({ type: "accepted", requestId: message.requestId, status: 200, headers: {} }));
        queueMicrotask(() => emit({
          type: "response",
          requestId: message.requestId,
          status: 200,
          headers: { "content-type": "application/json" },
          body: "{\"ok\":true}"
        }));
        queueMicrotask(() => emit({ type: "done", requestId: message.requestId }));
      }
    },
    disconnect() {
      for (const listener of disconnectListeners) listener();
    }
  };

  function emit(message) {
    for (const listener of messageListeners) listener(message);
  }

  globalThis.chrome = {
    runtime: {
      connect() {
        return port;
      }
    }
  };

  return { requests };
}

test("streams parsed SSE events through the port", async () => {
  const fake = installFakeExtension("stream");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation({ sessionId: "ses_test" });

  const stream = await conversation.chat.completions.create({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hi" }],
    stream: true
  });

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk?.choices?.[0]?.delta?.content || "");
  }

  assert.deepEqual(chunks, ["he", "llo"]);
  assert.equal(fake.requests[0].sessionId, "ses_test");
  assert.equal(fake.requests[0].api, "chat.completions");
  bridge.close();
});

test("returns a non-stream response with parsed JSON", async () => {
  const fake = installFakeExtension("response");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation();

  const response = await conversation.chat.completions.create({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hi" }],
    stream: false
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true });
  assert.equal(fake.requests.length, 1);
  bridge.close();
});

test("rejects with upstream error details", async () => {
  installFakeExtension("error");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation();

  await assert.rejects(
    conversation.responses.create({ model: "gpt-6-luna", input: "hi", stream: false }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_HTTP_ERROR");
      assert.equal(error.status, 400);
      assert.equal(error.body, "{\"error\":\"bad\"}");
      return true;
    }
  );
  bridge.close();
});

test("fetch adapter routes matching paths and ignores page auth", async () => {
  const fake = installFakeExtension("response");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation({ sessionId: "ses_fetch" });
  const bridgeFetch = conversation.createFetch();

  const response = await bridgeFetch(
    "https://opencode.ai/inference/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { authorization: "page-key-must-be-ignored" },
      body: JSON.stringify({ model: "kimi-k3", messages: [], stream: false })
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(fake.requests[0].sessionId, "ses_fetch");
  bridge.close();
});
