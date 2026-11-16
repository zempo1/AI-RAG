import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { ConfigService } from "@nestjs/config";
import { TokenizerService } from "../src/modules/embeddings/tokenizer.service";
import { LlmService } from "../src/modules/llm/llm.service";
import { MindMapGenerator, GenerationContext } from "../src/modules/mindmaps/mindmap-generator";
import { MindMapPlanner } from "../src/modules/mindmaps/mindmap-planner";
import { environmentBindings, runWithModels } from "../src/modules/model-settings/model-runtime";

describe("mindmap generation through the native DashScope Kimi HTTP adapter", () => {
  let server: Server;
  let config: ConfigService;
  let requests: any[];
  let mode: "normal" | "length" | "malformed" | "dense";
  const cache = new Map<string, unknown>();
  const notes = '{"topics":[{"topic":"校准","points":["每七天校准一次"]}]}';
  const tree =
    '{"text":"设备手册","children":[{"text":"校准","children":[{"text":"每七天校准一次"}]}]}';

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const buffers: Buffer[] = [];
      for await (const buffer of req) buffers.push(buffer);
      const body = JSON.parse(Buffer.concat(buffers).toString());
      requests.push(body);
      const prompt: string = body.messages[0].content;
      const extraction = prompt.includes("提炼精简要点");
      const bad = extraction && prompt.includes("BAD");
      const truncated =
        (bad && mode === "length") || (extraction && mode === "dense" && body.max_tokens < 1500);
      // Kimi's default thinking can consume the small structured-output budget.
      const content = truncated
        ? '{"topics":['
        : body.enable_thinking !== false || (bad && mode === "malformed")
          ? '{"invalid":"private-provider-content"}'
          : extraction
            ? notes
            : prompt.includes("<主题目录>")
              ? '{"title":"设备手册","groups":[{"title":"运维","ids":["t1"]}]}'
              : tree;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "kimi-test",
          object: "chat.completion",
          created: 1,
          model: "kimi-k3",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: truncated ? "length" : "stop",
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: truncated ? 1024 : 30,
            total_tokens: truncated ? 1044 : 50,
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    config = new ConfigService({ STORAGE_DRIVER: "memory", CHAT_API_KEY: "test-key" });
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    mode = "normal";
    requests = [];
    cache.clear();
  });
  function generate(strategy: "direct" | "batched", batches: string[]) {
    const bindings = environmentBindings(config);
    bindings.chat = {
      provider: "dashscope",
      model: "kimi-k3",
      custom: true,
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    };
    const controller = new AbortController();
    const context: GenerationContext = {
      signal: controller.signal,
      abort: (error) => controller.abort(error),
      guard: async () => controller.signal.throwIfAborted(),
      onAttempt: undefined,
      progress: async () => {},
      failed: async () => {},
      cache: async (phase, input, make, parse) => {
        const key = `${phase}:${input}`;
        if (cache.has(key)) return parse(cache.get(key));
        const value = await make();
        cache.set(key, value);
        return value;
      },
    };
    return runWithModels({ userId: 1, bindings }, () => {
      const planner = new MindMapPlanner(config, new TokenizerService(config));
      return new MindMapGenerator(config, planner, new LlmService(config)).generate(
        { strategy, batches },
        context,
      );
    });
  }

  it.each(["direct", "batched"] as const)(
    "generates a complete %s map without spending output tokens on thinking",
    async (strategy) => {
      const result = await generate(
        strategy,
        strategy === "direct" ? ["全文"] : ["第一章", "第二章"],
      );
      expect(result.root.data.text).toBe("设备手册");
      expect(JSON.stringify(result.root)).toContain("每七天校准一次");
      expect(requests).toHaveLength(strategy === "direct" ? 1 : 3);
      expect(requests.every((body) => body.enable_thinking === false)).toBe(true);
      expect(requests.every((body) => body.response_format?.type === "json_object")).toBe(true);
    },
  );

  it("reports output truncation without claiming any successful batches were cached", async () => {
    mode = "length";
    await expect(generate("batched", ["BAD-1", "BAD-2"])).rejects.toThrow(
      /2 个批次.*长度上限.*尚无成功批次/,
    );
    expect(cache.size).toBe(0);
    expect(requests).toHaveLength(2);
  });

  it("leaves enough output budget for dense batch notes before generating the global map", async () => {
    mode = "dense";
    const result = await generate("batched", ["包含多个独立主题的合成章节"]);
    expect(result.root.children[0].children[0].data.text).toBe("校准");
    expect(requests).toHaveLength(2);
  });

  it("reports a safe format error, preserves successful batches, and reuses them on retry", async () => {
    mode = "malformed";
    let message = "";
    try {
      await generate("batched", ["GOOD", "BAD"]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/1 个批次.*JSON.*1 个成功批次已缓存/);
    expect(message).not.toContain("private-provider-content");
    expect(cache.size).toBe(1);
    expect(requests).toHaveLength(3);
    mode = "normal";
    requests = [];
    const result = await generate("batched", ["GOOD", "BAD"]);
    expect(result.root.data.text).toBe("设备手册");
    expect(requests).toHaveLength(2);
  });
});
