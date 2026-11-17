import { ConfigService } from "@nestjs/config";
import { PdfVisualService } from "../src/modules/documents/parsers/pdf-visual.service";

it("retries a single timed-out request inside the regional budget and frees its slot", async () => {
  let calls = 0;
  const model = {
    complete: async (_p: string, _k: unknown, _i: unknown, signal: AbortSignal) => {
      calls++;
      if (calls > 1) return '{"blocks":[]}';
      return new Promise<string>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
  };
  const service = new PdfVisualService(
    new ConfigService({
      VISION_CONCURRENCY: 1,
      VISION_TIMEOUT_MS: 1200,
      VISION_REQUEST_TIMEOUT_MS: 30,
    }),
    model as any,
    {} as any,
  ) as any;
  await expect(
    service.vision(Buffer.from("image"), { context: "" }, 1, 1, {
      userId: 1,
      documentId: 1,
      versionId: 1,
    }),
  ).resolves.toEqual([]);
  expect(calls).toBe(2);
});

it("keeps the original total-deadline reason instead of a provider AbortError", async () => {
  const service = new PdfVisualService(
    new ConfigService({ VISION_CONCURRENCY: 1, VISION_TIMEOUT_MS: 30 }),
    {
      complete: async (_p: string, _k: unknown, _i: unknown, signal: AbortSignal) =>
        new Promise((_r, reject) =>
          signal.addEventListener("abort", () => reject(new Error("Request was aborted.")), {
            once: true,
          }),
        ),
    } as any,
    {} as any,
  ) as any;
  await expect(
    service.vision(Buffer.from("image"), { context: "" }, 1, 1, {
      userId: 1,
      documentId: 1,
      versionId: 1,
    }),
  ).rejects.toThrow("总时限");
});
