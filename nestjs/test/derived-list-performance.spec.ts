import { MindMapsService } from "../src/modules/mindmaps/mindmaps.service";
import { AnalysisService } from "../src/modules/analysis/analysis.service";
import { MemoryStore } from "../src/persistence/memory.store";
import type { Table } from "../src/persistence/store";

class CountingStore extends MemoryStore {
  reads: { table: Table; id: number }[] = [];
  override async get(table: Table, id: number) {
    this.reads.push({ table, id });
    return super.get(table, id);
  }
}

describe.each(["mindmaps", "analyses"] as const)("%s list reads", (table) => {
  async function fixture() {
    const store = new CountingStore();
    await store.save("documents", {
      id: 10,
      userId: 1,
      activeVersionId: 2,
      content: "完整来源正文",
    });
    const body =
      table === "mindmaps"
        ? { title: "导图", data: '{"root":{"data":{"text":"保留完整导图"}}}' }
        : { documentName: "资料.md", type: "SUMMARY", content: "保留完整分析正文" };
    for (const row of [
      { id: 1, userId: 1, documentId: 10, versionId: 1 },
      { id: 2, userId: 1, documentId: 10, versionId: 2 },
      { id: 3, userId: 1, documentId: 99, versionId: 1 },
      { id: 4, userId: 1, documentId: 99, versionId: 1 },
      { id: 5, userId: 1, documentId: null, versionId: null },
      { id: 6, userId: 2, documentId: 20, versionId: 1 },
    ])
      await store.save(table, { ...row, ...body, createdAt: "2026-11-15 12:00:00" });
    const service =
      table === "mindmaps"
        ? new MindMapsService(null as any, null as any, store)
        : new AnalysisService(null as any, null as any, store);
    const list = () =>
      table === "mindmaps"
        ? (service as MindMapsService).list(1)
        : (service as AnalysisService).list("SUMMARY", 1);
    return { store, list };
  }

  it("preserves complete public rows, ordering, ownership and outdated flags", async () => {
    const { list } = await fixture();
    const body =
      table === "mindmaps"
        ? { title: "导图", data: '{"root":{"data":{"text":"保留完整导图"}}}' }
        : { documentName: "资料.md", type: "SUMMARY", content: "保留完整分析正文" };
    expect(await list()).toEqual([
      {
        id: 5,
        documentId: null,
        versionId: null,
        ...body,
        createdAt: "2026-11-15T12:00:00",
        sourceOutdated: false,
      },
      {
        id: 4,
        documentId: 99,
        versionId: 1,
        ...body,
        createdAt: "2026-11-15T12:00:00",
        sourceOutdated: false,
      },
      {
        id: 3,
        documentId: 99,
        versionId: 1,
        ...body,
        createdAt: "2026-11-15T12:00:00",
        sourceOutdated: false,
      },
      {
        id: 2,
        documentId: 10,
        versionId: 2,
        ...body,
        createdAt: "2026-11-15T12:00:00",
        sourceOutdated: false,
      },
      {
        id: 1,
        documentId: 10,
        versionId: 1,
        ...body,
        createdAt: "2026-11-15T12:00:00",
        sourceOutdated: true,
      },
    ]);
  });

  it("reads each distinct source once and never reloads listed records", async () => {
    const { store, list } = await fixture();
    await list();
    expect(store.reads.filter((read) => read.table === table)).toEqual([]);
    expect(store.reads.filter((read) => read.table === "documents")).toEqual([
      { table: "documents", id: 99 },
      { table: "documents", id: 10 },
    ]);
  });

  it("refreshes source versions on the next request", async () => {
    const { store, list } = await fixture();
    await list();
    await store.save("documents", { id: 10, activeVersionId: 3 });
    store.reads = [];
    const rows = await list();
    expect(rows.find((row) => row.id === 2)?.sourceOutdated).toBe(true);
    expect(store.reads.filter((read) => read.table === "documents" && read.id === 10)).toHaveLength(
      1,
    );
  });
});

it("keeps the mindmap detail ownership check", async () => {
  const store = new CountingStore();
  await store.save("mindmaps", { id: 1, userId: 2, documentId: 10 });
  const service = new MindMapsService(null as any, null as any, store);
  await expect(service.get(1, 1)).rejects.toThrow("思维导图不存在");
  expect(store.reads).toEqual([{ table: "mindmaps", id: 1 }]);
});
