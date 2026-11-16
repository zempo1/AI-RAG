import { ConfigService } from "@nestjs/config";
import { redactModelError } from "../src/modules/model-settings/model-runtime";

it("preserves only safe provider status and retry delay after removing echoed credentials", () => {
  const key = "sensitive-provider-key";
  const error = Object.assign(new Error(`429 rejected key ${key}`), {
    status: 429,
    headers: { "retry-after": "2", authorization: key },
    response: { private: key },
  });
  const safe = redactModelError(new ConfigService({ CHAT_API_KEY: key }), error) as any;
  expect(safe).toBeInstanceOf(Error);
  expect(safe.message).not.toContain(key);
  expect(safe.status).toBe(429);
  expect(safe.retryAfterMs).toBe(2000);
  expect(safe.headers).toBeUndefined();
  expect(safe.response).toBeUndefined();
});
