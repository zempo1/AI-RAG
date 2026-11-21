import { AnalysisService } from "../src/modules/analysis/analysis.service";
import { MemoryStore } from "../src/persistence/memory.store";
import { ModelOutputError } from "../src/modules/llm/llm.types";

async function fixture() {
  const store = new MemoryStore();
  await store.save("knowledgeBases", { id: 1, userId: 1 });
  const doc = await store.save("documents", {
    id: 1,
    userId: 1,
    knowledgeBaseId: 1,
    filename: "long.md",
    content: "开头".repeat(11000) + "\n仅在文末出现的蒸腾作用",
    status: "ready",
    activeVersionId: 2,
    activeIndexRevisionId: 3,
  });
  await store.save("indexRevisions", { id: 3, documentId: 1, versionId: 2 });
  for (let i = 0; i < 25; i++)
    await store.save("chunks", {
      id: i + 10,
      documentId: 1,
      versionId: 2,
      indexRevisionId: 3,
      chunkIndex: i,
      text: i === 24 ? "仅在文末出现的蒸腾作用" : `章节 ${i} 的知识点`,
      location: { heading: `章节 ${i}` },
    });
  return {
    store,
    service: (complete: (prompt: string) => Promise<string>) =>
      new AnalysisService({ ready: async () => doc } as any, { complete } as any, store),
  };
}

function modelCards(prompt: string, call: number) {
  const sources = JSON.parse(prompt.match(/<原文>\n([\s\S]+?)\n<\/原文>/)![1]);
  const count = Number(prompt.match(/生成 ([12]) 张/)?.[1]);
  return JSON.stringify({
    cards: Array.from({ length: count }, (_, i) => ({
      q: `第 ${call} 批第 ${i + 1} 张的问题`,
      a: sources.at(-1).text,
      sourceId: sources.at(-1).sourceId,
    })),
  });
}

it("从当前索引的前中后取材，按批生成并原子保存 10 张卡片", async () => {
  const { service, store } = await fixture();
  const prompts: string[] = [];
  const generated = await service(async (prompt) => {
    prompts.push(prompt);
    return modelCards(prompt, prompts.length);
  }).generate(1, "FLASHCARD", 1);
  expect(prompts).toHaveLength(5);
  expect(prompts[0]).toContain("章节 0 的知识点");
  expect(prompts[2]).toMatch(/章节 (1[0-4]) 的知识点/);
  expect(prompts.join()).toContain("仅在文末出现的蒸腾作用");
  expect(prompts.join()).not.toContain("开头".repeat(50));
  expect(JSON.parse(generated.content)).toHaveLength(10);
  expect(await store.list("analyses")).toHaveLength(1);
});

it("无效的原文编号只修复一次，失败时不保存部分卡片", async () => {
  const { service, store } = await fixture();
  let calls = 0;
  await expect(
    service(async (prompt) => {
      calls++;
      const batch = JSON.parse(modelCards(prompt, calls));
      if (calls > 1) batch.cards[0].sourceId = "outside-this-batch";
      return JSON.stringify(batch);
    }).generate(1, "FLASHCARD", 1),
  ).rejects.toThrow("结构或原文校验");
  expect(calls).toBe(3);
  expect(await store.list("analyses")).toHaveLength(0);
});

it("长度截断后降为单张生成，仍会尝试末尾分块", async () => {
  const { service } = await fixture();
  const prompts: string[] = [];
  const generated = await service(async (prompt) => {
    prompts.push(prompt);
    if (prompts.length === 1) throw new ModelOutputError("模型输出截断", "length");
    return modelCards(prompt, prompts.length);
  }).generate(1, "FLASHCARD", 1);
  expect(prompts).toHaveLength(11);
  expect(prompts.slice(1).every((prompt) => prompt.includes("生成 1 张"))).toBe(true);
  expect(prompts.at(-1)).toContain("仅在文末出现的蒸腾作用");
  expect(JSON.parse(generated.content)).toHaveLength(10);
});

it("来源索引在生成中切换时不会保存半套或过期卡片", async () => {
  const { service, store } = await fixture();
  await expect(
    service(async (prompt) => {
      await store.save("documents", { id: 1, activeIndexRevisionId: 4 });
      return modelCards(prompt, 1);
    }).generate(1, "FLASHCARD", 1),
  ).rejects.toThrow("来源版本或索引已更新");
  expect(await store.list("analyses")).toHaveLength(0);
});
