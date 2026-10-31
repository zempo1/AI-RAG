import test from "node:test";
import assert from "node:assert/strict";
import { SseDecoder } from "../src/utils/sse.ts";

test("decodes UTF-8 and SSE frames split at every byte, with multiple named events", () => {
  const bytes = new TextEncoder().encode(
    'event: chatId\r\ndata: 3\r\n\r\ndata: "中文\\n正文"\n\nevent: done\ndata: {"answer":"答案","citations":[]}\n\n',
  );
  const decoder = new SseDecoder();
  const events = [];
  for (const byte of bytes) events.push(...decoder.feed(Uint8Array.of(byte)));
  events.push(...decoder.finish());
  assert.deepEqual(events, [
    { event: "chatId", data: "3" },
    { event: "message", data: '"中文\\n正文"' },
    { event: "done", data: '{"answer":"答案","citations":[]}' },
  ]);
});
test("joins multiline data, ignores comments and retains unfinished lines", () => {
  const decoder = new SseDecoder();
  assert.deepEqual(
    decoder.feed(
      new TextEncoder().encode(
        ": heartbeat\n\nevent: sources\ndata: first\ndata: sec",
      ),
    ),
    [],
  );
  assert.deepEqual(decoder.feed(new TextEncoder().encode("ond\n\n")), [
    { event: "sources", data: "first\nsecond" },
  ]);
});
