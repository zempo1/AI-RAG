import { ConfigService } from "@nestjs/config";
import { TokenizerService } from "../src/modules/embeddings/tokenizer.service";
import { MindMapsService } from "../src/modules/mindmaps/mindmaps.service";
import { pipeline } from "./helpers/pipeline";

const tree = JSON.stringify({
  root: { data: { text: "主题" }, children: [{ data: { text: "要点" } }] },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("mindmap execution races", () => {
  it.each(["cancel", "replace"])(
    "does not publish after %s while the model is running",
    async (action) => {
      const p = await pipeline();
      const entered = deferred(),
        release = deferred();
      try {
        const file = await p.documents.ingest(Buffer.from("# 章节\n\n原文知识点"), "race.md", 1);
        await p.indexing.process(file.taskId);
        const config = new ConfigService({ STORAGE_DRIVER: "memory", JWT_SECRET: "x".repeat(32) });
        const llm = {
          complete: async () => {
            entered.resolve();
            await release.promise;
            return tree;
          },
        };
        const service = new MindMapsService(
          p.documents,
          llm as any,
          p.store,
          config,
          new TokenizerService(config),
          p.tasks,
        );
        const accepted = await service.generate(1, file.documentId, undefined, "race-" + action);
        const execution = service.process(accepted.taskId).catch(() => undefined);
        await entered.promise;
        if (action === "cancel") {
          await p.store.save("tasks", {
            id: accepted.taskId,
            status: "canceled",
            executionToken: null,
          });
        } else {
          const replacement = await p.documents.ingest(
            Buffer.from("# 新章节\n\n更新原文"),
            "race.md",
            1,
            { documentId: file.documentId },
          );
          await p.indexing.process(replacement.taskId);
        }
        release.resolve();
        await execution;
        expect(await p.store.list("mindmaps")).toHaveLength(0);
        expect((await p.store.get("tasks", accepted.taskId))?.status).not.toBe("completed");
      } finally {
        release.resolve();
        await p.cleanup();
      }
    },
  );

  it("keeps another user's generated task and document inaccessible", async () => {
    const p = await pipeline();
    try {
      const file = await p.documents.ingest(Buffer.from("私有来源"), "private.md", 1);
      await p.indexing.process(file.taskId);
      const config = new ConfigService({ STORAGE_DRIVER: "memory", JWT_SECRET: "x".repeat(32) });
      const service = new MindMapsService(
        p.documents,
        { complete: async () => tree } as any,
        p.store,
        config,
        new TokenizerService(config),
        p.tasks,
      );
      const accepted = await service.generate(1, file.documentId, undefined, "private");
      await expect(p.tasks.get(accepted.taskId, 2)).rejects.toThrow();
      await expect(service.generate(2, file.documentId, undefined, "intrusion")).rejects.toThrow();
    } finally {
      await p.cleanup();
    }
  });
});
