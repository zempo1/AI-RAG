import { ConfigService } from "@nestjs/config";
import { TokenizerService } from "../src/modules/embeddings/tokenizer.service";
import { MindMapPlanner } from "../src/modules/mindmaps/mindmap-planner";
import { MindMapGenerator, GenerationContext } from "../src/modules/mindmaps/mindmap-generator";
import { ModelOutputError } from "../src/modules/llm/llm.types";

function context(controller = new AbortController()): GenerationContext {
  return {
    signal: controller.signal,
    abort: (error) => controller.abort(error),
    guard: async () => controller.signal.throwIfAborted(),
    onAttempt: undefined,
    progress: async () => {},
    failed: async () => {},
    cache: async (_phase, _input, make) => make(),
  };
}
const notes = JSON.stringify({ topics: [{ topic: "主题", points: ["要点"] }] });
const tree = JSON.stringify({ text: "主题", children: [] });

it("reserves the permitted repair prompt when choosing the direct strategy", async () => {
  const base = new ConfigService({ STORAGE_DRIVER: "memory", CHAT_OUTPUT_TOKENS: 128 });
  const initial = new MindMapPlanner(base, new TokenizerService(base));
  const chunks = [{ id: 1, chunkIndex: 0, text: "a".repeat(300), location: { page: 1 } }];
  const input = initial.reconstruct(chunks).join("\n\n");
  const exact = (await initial.count(initial.prompt("direct", input))) + 128 + 1024;
  const config = new ConfigService({
    STORAGE_DRIVER: "memory",
    CHAT_OUTPUT_TOKENS: 128,
    CHAT_CONTEXT_TOKENS: exact,
  });
  const planner = new MindMapPlanner(config, new TokenizerService(config));
  expect(await planner.fits("direct", input)).toBe(true);
  expect(await planner.fits("direct", input, true)).toBe(false);
  expect((await planner.plan(chunks)).strategy).toBe("batched");
});

it("settles every in-flight extraction before returning a fatal provider error", async () => {
  const cfg = new ConfigService({ STORAGE_DRIVER: "memory", MINDMAP_CONCURRENCY: 3 });
  const planner = new MindMapPlanner(cfg, new TokenizerService(cfg));
  const controller = new AbortController();
  let started = 0,
    settled = 0,
    allStarted!: () => void;
  const ready = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const generator = new MindMapGenerator(cfg, planner, {
    complete: async (_p: string, _k: unknown, _i: unknown, _s: unknown, options: any) => {
      const ordinal = ++started;
      if (started === 3) allStarted();
      try {
        if (ordinal === 1) {
          await ready;
          throw Object.assign(new Error("unauthorized"), { status: 401 });
        }
        await new Promise<void>((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => setTimeout(() => reject(options.signal.reason), 20),
            { once: true },
          ),
        );
        return notes;
      } finally {
        settled++;
      }
    },
  } as any);
  await expect(
    generator.generate({ strategy: "batched", batches: ["A", "B", "C", "D"] }, context(controller)),
  ).rejects.toThrow("unauthorized");
  expect(started).toBe(3);
  expect(settled).toBe(3);
});

it("bounds rate-limit retries and never treats transport errors as malformed JSON", async () => {
  const cfg = new ConfigService({ STORAGE_DRIVER: "memory" });
  const planner = new MindMapPlanner(cfg, new TokenizerService(cfg));
  let calls = 0;
  const generator = new MindMapGenerator(cfg, planner, {
    complete: async () => {
      calls++;
      throw Object.assign(new Error("limited"), { status: 429, headers: { "retry-after": "0" } });
    },
  } as any);
  await expect(
    generator.generate({ strategy: "direct", batches: ["正文"] }, context()),
  ).rejects.toThrow("limited");
  expect(calls).toBe(3);
});

it("assembles all facts locally when organization does not fit, without another summary call", async () => {
  const cfg = new ConfigService({ STORAGE_DRIVER: "memory" });
  const planner = new MindMapPlanner(cfg, new TokenizerService(cfg));
  planner.fits = async (phase) => phase !== "organize";
  planner.pack = async (parts) => [parts.join("\n\n")];
  const phases: string[] = [];
  const generator = new MindMapGenerator(cfg, planner, {
    complete: async (prompt: string) => {
      phases.push(
        prompt.includes("压缩全部")
          ? "compress"
          : prompt.includes("提炼精简要点")
            ? "extract"
            : "final",
      );
      return prompt.includes("压缩全部")
        ? JSON.stringify({ topics: [{ topic: "长".repeat(100), points: ["更长".repeat(100)] }] })
        : notes;
    },
  } as any);
  const map = await generator.generate({ strategy: "batched", batches: ["甲", "乙"] }, context());
  expect(map.meta?.assembly.organization).toBe("source-order");
  expect(JSON.stringify(map.root)).toContain("要点");
  expect(phases).toEqual(["extract", "extract"]);
});

it("keeps extracted facts when the organization response is truncated", async () => {
  const cfg = new ConfigService({ STORAGE_DRIVER: "memory" });
  const planner = new MindMapPlanner(cfg, new TokenizerService(cfg));
  let calls = 0;
  const generator = new MindMapGenerator(cfg, planner, {
    complete: async (prompt: string) => {
      calls++;
      if (prompt.includes("提炼精简要点")) return notes;
      throw new ModelOutputError("截断", "length");
    },
  } as any);
  const map = await generator.generate({ strategy: "batched", batches: ["正文"] }, context());
  expect(calls).toBe(2);
  expect(JSON.stringify(map.root)).toContain("要点");
  expect(map.meta?.assembly.organization).toBe("source-order");
});

it("recovers a truncated direct response via extraction and ID organization", async () => {
  const cfg = new ConfigService({ STORAGE_DRIVER: "memory" });
  const planner = new MindMapPlanner(cfg, new TokenizerService(cfg));
  const prompts: string[] = [];
  const generator = new MindMapGenerator(cfg, planner, {
    complete: async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.includes("根据全文一次")) throw new ModelOutputError("截断", "length");
      if (prompt.includes("提炼精简要点")) return notes;
      return '{"title":"主题","groups":[{"title":"分组","ids":["t1"]}]}';
    },
  } as any);
  const map = await generator.generate({ strategy: "direct", batches: ["正文"] }, context());
  expect(prompts).toHaveLength(3);
  expect(prompts[2]).not.toContain("要点");
  expect(map.root.children[0].children[0].children[0].data.text).toBe("要点");
});

it("splits a single oversized source without dropping any character", async () => {
  const cfg = new ConfigService({
    STORAGE_DRIVER: "memory",
    CHAT_CONTEXT_TOKENS: 4096,
    CHAT_OUTPUT_TOKENS: 1024,
  });
  const planner = new MindMapPlanner(cfg, new TokenizerService(cfg));
  const text = "原文😀".repeat(6000);
  const batches = await planner.pack([text], "extract");
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.join("")).toBe(text);
  for (const batch of batches) expect(await planner.fits("extract", batch, true)).toBe(true);
});
