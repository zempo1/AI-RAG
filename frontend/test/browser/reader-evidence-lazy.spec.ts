import { test, expect, type Page, type Route } from "@playwright/test";

const citations = [1, 2, 3].map((number) => ({
  number,
  documentId: 1,
  versionId: 11,
  knowledgeBaseId: 1,
  indexRevisionId: 21,
  chunkId: number,
  filename: "引用快照.pdf",
  text: `引用原文 ${number}`,
  score: 1,
  ...(number === 3 ? { sourceDeleted: true } : {}),
  location: {
    page: number,
    paragraph: 1,
    heading: null,
    start: (number - 1) * 100,
    end: (number - 1) * 100 + 6,
    contentType: "native",
    pageImage: { versionId: 11, page: number, profile: "reader" },
  },
}));
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrAAAAABJRU5ErkJggg==",
  "base64",
);

async function fixture(page: Page, deferred = false) {
  const state = {
    contexts: [] as Route[],
    images: [] as Route[],
    previews: 0,
    failed: [] as string[],
  };
  page.on("requestfailed", (request) => state.failed.push(request.url()));
  await page.addInitScript(() => {
    localStorage.setItem("token", "test-token");
    localStorage.setItem("username", "tester");
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (url.hostname !== "127.0.0.1") return route.abort();
    if (!path.startsWith("/api/")) return route.continue();
    const body = (data: unknown) => route.fulfill({ json: { data } });
    if (path === "/api/knowledge-bases")
      return body([{ id: 1, name: "测试知识库", description: "", rebuildTaskId: null }]);
    if (path === "/api/chats") return body([{ id: 7, title: "快照历史", knowledgeBaseId: 1 }]);
    if (path === "/api/chats/7")
      return body({
        id: 7,
        knowledgeBaseId: 1,
        pendingTasks: [],
        messages: [
          {
            role: "assistant",
            content: "第一段[1]，第二段[2]，已删除[3]",
            citations,
            sources: citations,
          },
        ],
      });
    if (path.endsWith("/documents")) return body({ items: [], total: 0 });
    if (path.endsWith("/preview")) {
      state.previews++;
      return body({
        documentId: 1,
        versionId: 11,
        filename: "引用快照.pdf",
        mimeType: "application/pdf",
        originalAvailable: false,
        originalUrl: null,
      });
    }
    if (path.endsWith("/citation-context")) {
      state.contexts.push(route);
      if (deferred) return;
      return body({ text: "展开后的上下文，包含引用原文 1，保留相邻内容。" });
    }
    if (path.endsWith("/image")) {
      state.images.push(route);
      if (deferred) return;
      return route.fulfill({ contentType: "image/png", body: pixel });
    }
    return body([]);
  });
  await page.goto("/");
  await page.getByText("快照历史", { exact: true }).click();
  await page.locator('[data-citation="1"]').click();
  const reader = page.getByRole("region", { name: "文档阅读器" });
  await expect(reader).toContainText("没有可用原件");
  return { state, reader, summary: reader.locator(".reader-evidence summary") };
}

test("折叠快照不请求扩展上下文和兜底图片，展开才读取并显示保存的原文", async ({ page }) => {
  const { state, reader, summary } = await fixture(page);
  await expect(reader.locator(".source-text")).toHaveText("引用原文 1");
  await expect(reader.locator(".source-text")).toBeHidden();
  expect(state.contexts).toHaveLength(0);
  expect(state.images).toHaveLength(0);
  await summary.click();
  await expect(reader.locator(".source-text")).toHaveText(
    "展开后的上下文，包含引用原文 1，保留相邻内容。",
  );
  await expect(reader.getByRole("img")).toBeVisible();
  expect(state.contexts).toHaveLength(1);
  expect(state.images).toHaveLength(1);
  await summary.click();
  await summary.click();
  await expect(reader.locator(".source-text")).toHaveText(
    "展开后的上下文，包含引用原文 1，保留相邻内容。",
  );
  expect(state.contexts).toHaveLength(1);
});

test("折叠取消上下文和图片在途请求，切换引用立即清旧上下文且最后一次生效", async ({ page }) => {
  const { state, reader, summary } = await fixture(page, true);
  await summary.click();
  await expect.poll(() => state.contexts.length).toBe(1);
  await expect.poll(() => state.images.length).toBe(1);
  await summary.click();
  await expect
    .poll(() => state.failed.filter((url) => url.includes("citation-context")).length)
    .toBe(1);
  await expect.poll(() => state.failed.filter((url) => url.includes("/image")).length).toBe(1);
  await expect(reader.locator(".source-text")).toHaveText("引用原文 1");
  await summary.click();
  await expect.poll(() => state.contexts.length).toBe(2);
  await page.locator('[data-citation="2"]').click();
  await expect(reader.locator(".source-text")).toHaveText("引用原文 2");
  await expect.poll(() => state.contexts.length).toBe(3);
  expect(new URL(state.contexts[2].request().url()).searchParams.get("start")).toBe("100");
  await state.contexts[2].fulfill({ json: { data: { text: "第二段上下文：引用原文 2。" } } });
  await expect(reader.locator(".source-text")).toHaveText("第二段上下文：引用原文 2。");
  await state.contexts[1]
    .fulfill({ json: { data: { text: "迟到的引用原文 1，不得覆盖当前引用。" } } })
    .catch(() => undefined);
  await expect(reader.locator(".source-text")).toHaveText("第二段上下文：引用原文 2。");
  await page.locator('[data-citation="1"]').click();
  await expect(reader.locator(".source-text")).toHaveText("引用原文 1");
});

test("已删除来源展开仍显示保存快照且不请求扩展上下文或图片", async ({ page }) => {
  const { state, reader, summary } = await fixture(page);
  await page.locator('[data-citation="3"]').click();
  await expect(reader).toContainText("来源已删除");
  await summary.click();
  await expect(reader.locator(".source-text")).toHaveText("引用原文 3");
  await expect(reader.locator(".source-text")).toBeVisible();
  expect(state.contexts).toHaveLength(0);
  expect(state.images).toHaveLength(0);
});
