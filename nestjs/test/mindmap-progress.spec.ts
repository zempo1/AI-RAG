import { pipeline } from "./helpers/pipeline";

it("presents only safe mindmap generation metrics in task detail and workspace task lists", async () => {
  const p = await pipeline();
  try {
    const kb = await p.libraries.resolve(1);
    const task = await p.tasks.create(p.store, {
      userId: 1,
      knowledgeBaseId: kb.id,
      kind: "mindmap",
      status: "completed",
      stage: "completed",
      payload: {
        credential: "private-key",
        modelSnapshot: "sealed",
        mindmapProgress: {
          strategy: "batched",
          modelCalls: 4,
          cacheHits: 1,
          startedAt: "2026-11-15T00:00:00.000Z",
          elapsedMs: 65000,
          prompt: "private-source",
          rawResponse: "private-output",
        },
      },
    });
    for (const row of [await p.tasks.get(task.id, 1), ...(await p.tasks.list(1, kb.id))]) {
      expect(row.mindmapProgress).toEqual({
        strategy: "batched",
        modelCalls: 4,
        cacheHits: 1,
        startedAt: "2026-11-15T00:00:00.000Z",
        elapsedMs: 65000,
      });
      expect(JSON.stringify(row)).not.toMatch(/private-|sealed|rawResponse/);
    }
  } finally {
    await p.cleanup();
  }
});
