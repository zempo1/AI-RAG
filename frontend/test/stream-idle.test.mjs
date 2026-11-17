import { test } from "node:test";
import assert from "node:assert/strict";
import { readWithIdleTimeout } from "../src/utils/stream-idle.ts";
test("stops a silent connection instead of waiting forever", async () => {
  await assert.rejects(
    readWithIdleTimeout({ read: () => new Promise(() => {}) }, 20),
    /连接长时间无响应/,
  );
});
test("accepts heartbeat bytes even if they contain no answer", async () => {
  const value = { done: false, value: new Uint8Array([58, 10, 10]) };
  assert.equal(await readWithIdleTimeout({ read: async () => value }, 20), value);
});
