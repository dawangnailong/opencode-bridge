import test from "node:test";
import assert from "node:assert/strict";
import { SSEParser } from "../sdk/opencode-bridge.js";

test("parses one complete event", () => {
  const parser = new SSEParser();
  const events = parser.feed('data: {"a":1}\n\n');

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "message");
  assert.equal(events[0].data, '{"a":1}');
});

test("buffers an event split across chunks", () => {
  const parser = new SSEParser();
  assert.deepEqual(parser.feed("data: hel"), []);
  const events = parser.feed("lo\n\n");

  assert.equal(events.length, 1);
  assert.equal(events[0].data, "hello");
});

test("handles a CRLF boundary split across chunks", () => {
  const parser = new SSEParser();
  assert.deepEqual(parser.feed("data: hi\r"), []);
  const events = parser.feed("\n\r\n");

  assert.equal(events.length, 1);
  assert.equal(events[0].data, "hi");
});

test("joins multi-line data fields", () => {
  const parser = new SSEParser();
  const events = parser.feed("data: one\ndata: two\n\n");

  assert.equal(events.length, 1);
  assert.equal(events[0].data, "one\ntwo");
});

test("ignores comment lines", () => {
  const parser = new SSEParser();
  const events = parser.feed(": keepalive\n\ndata: value\n\n");

  assert.equal(events.length, 1);
  assert.equal(events[0].data, "value");
});

test("parses event, id, and retry fields", () => {
  const parser = new SSEParser();
  const events = parser.feed("event: delta\nid: 42\nretry: 1500\ndata: value\n\n");

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "delta");
  assert.equal(events[0].id, "42");
  assert.equal(events[0].retry, 1500);
  assert.equal(events[0].data, "value");
});

test("flushes a final event without a trailing blank line", () => {
  const parser = new SSEParser();
  assert.deepEqual(parser.feed("data: final"), []);
  const events = parser.flush();

  assert.equal(events.length, 1);
  assert.equal(events[0].data, "final");
});

test("preserves the DONE sentinel", () => {
  const parser = new SSEParser();
  const events = parser.feed("data: [DONE]\n\n");

  assert.equal(events.length, 1);
  assert.equal(events[0].data, "[DONE]");
});

test("handles UTF-8 text split across chunks", () => {
  const parser = new SSEParser();
  parser.feed("data: 你");
  const events = parser.feed("好\n\n");

  assert.equal(events.length, 1);
  assert.equal(events[0].data, "你好");
});

test("dispatches empty data fields", () => {
  const parser = new SSEParser();
  const events = parser.feed("data:\n\n");

  assert.equal(events.length, 1);
  assert.equal(events[0].data, "");
});
