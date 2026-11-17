import { test, expect, type Page, type Route } from "@playwright/test";

const analysis = (documentName: string) => ({
  id: 21,
  documentId: 7,
  documentName,
  type: "OUTLINE",
  content: "摘要正文",
  createdAt: "2026-11-15T01:00:00Z",
});

for (const [label, type] of [
  ["文档大纲", "OUTLINE"],
  ["学习卡片", "FLASHCARD"],
]) {
  test(`${label}按知识库读取且忽略切换后的旧响应`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let oldStarted = false;
    await page.route(
      (url) => url.pathname === "/src/main.ts",
      async (route) => {
        const response = await route.fetch();
        const body = (await response.text())
          .replace(/import\s*\{\s*createApp\s*\}/, "import {createApp, ref, h}")
          .replace(/"\/src\/app\/App\.vue(?:\?[^\"]*)?"/, '"/src/features/workbench/Workbench.vue"')
          .replace(
            "createApp(App)",
            `createApp({setup(){const kb=ref(1);window.setLibrary=id=>kb.value=id;return()=>h(App,{uploadedFileName:'资料',uploadedDocumentId:7,knowledgeBaseId:kb.value});}})`,
          );
        await route.fulfill({ response, body });
      },
    );
    await page.route(
      (url) => url.pathname.startsWith("/api/"),
      async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/analysis") {
          expect(url.searchParams.get("type")).toBe(type);
          const kb = url.searchParams.get("knowledgeBaseId");
          expect(["1", "2"]).toContain(kb);
          if (kb === "1") {
            oldStarted = true;
            await gate;
          }
          await route.fulfill({
            json: { data: [{ ...analysis(kb === "1" ? "旧知识库内容" : "新知识库内容"), type }] },
          });
        } else await route.fulfill({ json: { data: { items: [], generationTasks: [] } } });
      },
    );
    await page.goto("/");
    await page.locator(".wb-tab").getByText(label, { exact: true }).click();
    await expect.poll(() => oldStarted).toBe(true);
    await page.evaluate(() => (window as any).setLibrary(2));
    await expect(page.getByText("新知识库内容", { exact: true })).toBeVisible();
    release();
    await expect(page.getByText("旧知识库内容", { exact: true })).toHaveCount(0);
    await expect(page.getByText("新知识库内容", { exact: true })).toBeVisible();
  });
}

test("仅生成中的任务显示进度和预计时间，完成取消仅保留历史", async ({ page }) => {
  const tasks = [
    {
      id: 91,
      kind: "mindmap",
      status: "running",
      stage: "mapping",
      completed: 3,
      total: 7,
      mindmapProgress: { strategy: "batched", elapsedMs: 30000 },
    },
    {
      id: 92,
      kind: "mindmap",
      status: "completed",
      stage: "completed",
      mindmapResult: { mindMapId: 7 },
    },
    { id: 93, kind: "mindmap", status: "canceled", stage: "canceled" },
  ];
  await mountWorkbench(page, async (route) =>
    route.fulfill({
      json: {
        data: {
          items: [{ id: 7, title: "已保存的导图", createdAt: "2026-11-16" }],
          generationTasks: tasks,
        },
      },
    }),
  );
  const rows = page.locator(".generation-task");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("提炼要点");
  await expect(rows).toContainText("预计还需约");
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  await expect(page.getByText("已保存的导图", { exact: true })).toBeVisible();
  await expect(rows).not.toContainText("tokens");
  await expect(rows).not.toContainText("模型请求");
  await page.screenshot({ path: "test-results/mindmap-progress-preview.png" });
});

test("没有可估算批次时诚实显示估算中，失败保留重试", async ({ page }) => {
  await mountWorkbench(page, async (route) =>
    route.fulfill({
      json: {
        data: {
          items: [],
          generationTasks: [
            {
              id: 1,
              kind: "mindmap",
              status: "running",
              stage: "generating",
              mindmapProgress: { strategy: "direct", elapsedMs: 5000 },
            },
            {
              id: 2,
              kind: "mindmap",
              status: "failed",
              stage: "failed",
              error: "网络异常",
              retryable: 1,
            },
          ],
        },
      },
    }),
  );
  await expect(page.locator(".generation-tasks")).toContainText("剩余时间估算中");
  await expect(page.getByRole("button", { name: "重试生成", exact: true })).toBeVisible();
});

// 使用真实工作台及其公开接口，只有外部 API 被替换；复用 Vite 已解析的依赖。
async function mountWorkbench(
  page: Page,
  handle: (route: Route, key: string) => Promise<void>,
  active = false,
) {
  await page.route(
    (url) => url.pathname === "/src/main.ts",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text())
        .replace(/"\/src\/app\/App\.vue(?:\?[^\"]*)?"/, '"/src/features/workbench/Workbench.vue"')
        .replace(
          "createApp(App)",
          `createApp(App, { uploadedFileName: "测试资料", uploadedDocumentId: 7, active: ${active} })`,
        )
        .replace('app.mount("#app")', 'window.workbench = app.mount("#app")');
      await route.fulfill({ response, body });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/mindmaps/workspace") {
        const wrapped = new Proxy(route, {
          get(target, key) {
            if (key === "fulfill")
              return (options: any) => {
                const data = options.json?.data;
                if (Array.isArray(data))
                  options = {
                    ...options,
                    json: { ...options.json, data: { items: data, generationTasks: [] } },
                  };
                return target.fulfill(options);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return handle(wrapped, url.pathname + url.search);
      }
      return handle(route, url.pathname + url.search);
    },
  );
  await page.goto("/");
  await expect(page.locator(".workbench")).toBeVisible();
}

async function invoke(
  page: Page,
  method: "refresh" | "onSourceDeleted" | "loadOutlines",
  argument?: number,
) {
  await page.evaluate(
    async ({ method, argument }) => {
      await (window as any).workbench[method](argument);
    },
    { method, argument },
  );
}

test("刷新仅重取当前标签，其余已访问标签在下次打开时更新", async ({ page }) => {
  const counts = new Map<string, number>();
  await mountWorkbench(page, async (route, key) => {
    counts.set(key, (counts.get(key) || 0) + 1);
    await route.fulfill({ json: { data: [] } });
  });
  await expect(page.getByText("暂无思维导图", { exact: true })).toBeVisible();
  await page.locator(".wb-tab").getByText("文档大纲", { exact: true }).click();
  await expect(page.getByText("暂无大纲记录", { exact: true })).toBeVisible();
  await invoke(page, "refresh");
  expect(counts.get("/api/mindmaps/workspace")).toBe(1);
  expect(counts.get("/api/analysis?type=OUTLINE")).toBe(2);
  expect(counts.has("/api/analysis?type=FLASHCARD")).toBe(false);
  await page.locator(".wb-tab").getByText("思维导图", { exact: true }).click();
  await expect.poll(() => counts.get("/api/mindmaps/workspace")).toBe(2);
  await page.locator(".wb-tab").getByText("文档大纲", { exact: true }).click();
  await expect(page.getByText("暂无大纲记录", { exact: true })).toBeVisible();
  expect(counts.get("/api/analysis?type=OUTLINE")).toBe(2);
});

test("标签加载失败后重新切换会重试并显示结果", async ({ page }) => {
  let attempts = 0;
  await mountWorkbench(page, async (route, key) => {
    if (key === "/api/analysis?type=OUTLINE") {
      attempts++;
      await route.fulfill(
        attempts === 1
          ? { status: 500, json: { message: "暂时不可用" } }
          : { json: { data: [analysis("重试后摘要")] } },
      );
    } else await route.fulfill({ json: { data: [] } });
  });
  await page.locator(".wb-tab").getByText("文档大纲", { exact: true }).click();
  await expect(page.getByText("暂无大纲记录", { exact: true })).toBeVisible();
  await page.locator(".wb-tab").getByText("思维导图", { exact: true }).click();
  await page.locator(".wb-tab").getByText("文档大纲", { exact: true }).click();
  await expect(page.locator(".analysis-doc")).toHaveText("重试后摘要");
  expect(attempts).toBe(2);
});

test("同一标签的并发读取复用在途请求", async ({ page }) => {
  let requests = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mountWorkbench(page, async (route, key) => {
    if (key === "/api/analysis?type=OUTLINE") {
      requests++;
      await ready;
      await route.fulfill({ json: { data: [analysis("共享加载结果")] } });
    } else await route.fulfill({ json: { data: [] } });
  });
  await page.locator(".wb-tab").getByText("文档大纲", { exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await page.locator(".wb-tab").getByText("思维导图", { exact: true }).click();
  await page.locator(".wb-tab").getByText("文档大纲", { exact: true }).click();
  const pending = page.evaluate(async () => {
    await Promise.all([
      (window as any).workbench.loadOutlines(),
      (window as any).workbench.loadOutlines(),
    ]);
  });
  await expect(page.getByText("加载中…", { exact: true })).toBeVisible();
  release();
  await pending;
  await expect(page.locator(".analysis-doc")).toHaveText("共享加载结果");
  expect(requests).toBe(1);
});

test("刷新后完成的过期请求不会覆盖新结果", async ({ page }) => {
  let requests = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mountWorkbench(page, async (route, key) => {
    if (key === "/api/analysis?type=OUTLINE") {
      requests++;
      const first = requests === 1;
      if (first) await ready;
      await route.fulfill({ json: { data: [analysis(first ? "过期摘要" : "刷新后摘要")] } });
    } else await route.fulfill({ json: { data: [] } });
  });
  await page.locator(".wb-tab").getByText("文档大纲", { exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await invoke(page, "refresh");
  await expect(page.locator(".analysis-doc")).toHaveText("刷新后摘要");
  const oldResponse = page.waitForResponse((response) =>
    response.url().includes("/api/analysis?type=OUTLINE"),
  );
  release();
  await oldResponse;
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".analysis-doc")).toHaveText("刷新后摘要");
});

test("删除来源只刷新当前标签，未打开的标签保持按需读取", async ({ page }) => {
  const counts = new Map<string, number>();
  await mountWorkbench(page, async (route, key) => {
    counts.set(key, (counts.get(key) || 0) + 1);
    await route.fulfill({ json: { data: [] } });
  });
  await expect(page.getByText("暂无思维导图", { exact: true })).toBeVisible();
  await invoke(page, "onSourceDeleted", 7);
  expect(counts.get("/api/mindmaps/workspace")).toBe(2);
  expect(counts.has("/api/analysis?type=OUTLINE")).toBe(false);
  expect(counts.has("/api/analysis?type=OUTLINE")).toBe(false);
  expect(counts.has("/api/analysis?type=FLASHCARD")).toBe(false);
  await page.locator(".wb-tab").getByText("文档大纲", { exact: true }).click();
  await expect(page.getByText("暂无大纲记录", { exact: true })).toBeVisible();
  expect(counts.get("/api/analysis?type=OUTLINE")).toBe(1);
});

const artifactTabs = [
  {
    label: "思维导图",
    list: "/api/mindmaps/workspace",
    generate: "/api/mindmaps/generate",
    remove: "/api/mindmaps/21",
    button: "生成思维导图",
    title: ".map-title",
    item: {
      id: 21,
      documentId: 7,
      title: "新产物",
      data: '{"data":{"text":"根节点"}}',
      createdAt: "2026-11-15T01:00:00Z",
    },
  },
  {
    label: "文档大纲",
    list: "/api/analysis?type=OUTLINE",
    generate: "/api/analysis/generate",
    remove: "/api/analysis/21",
    button: "生成文档大纲",
    title: ".analysis-doc",
    item: { ...analysis("新产物"), type: "OUTLINE" },
  },
  {
    label: "学习卡片",
    list: "/api/analysis?type=FLASHCARD",
    generate: "/api/analysis/generate",
    remove: "/api/analysis/21",
    button: "生成学习卡片",
    title: ".map-title",
    item: { ...analysis("新产物"), type: "FLASHCARD", content: '[{"q":"问题","a":"答案"}]' },
  },
];

for (const artifact of artifactTabs) {
  test(`${artifact.label}生成成功使生成前在途列表失效`, async ({ page }) => {
    let reads = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mountWorkbench(page, async (route, key) => {
      if (key === artifact.list) {
        reads++;
        const first = reads === 1;
        if (first) await ready;
        await route.fulfill({ json: { data: first ? [] : [artifact.item] } });
      } else if (key === artifact.generate) {
        await route.fulfill({
          json: {
            data: artifact.label === "思维导图" ? { taskId: 91, status: "queued" } : artifact.item,
          },
        });
      } else await route.fulfill({ json: { data: [] } });
    });
    if (artifact.label !== "思维导图")
      await page.locator(".wb-tab").getByText(artifact.label, { exact: true }).click();
    await expect.poll(() => reads).toBe(1);
    try {
      await page.getByRole("button", { name: artifact.button, exact: true }).click();
      await expect.poll(() => reads).toBe(2);
      await expect(page.locator(artifact.title)).toHaveText("新产物");
    } finally {
      release();
    }
    await page.waitForLoadState("networkidle");
    await expect(page.locator(artifact.title)).toHaveText("新产物");
  });

  test(`${artifact.label}删除后在途旧列表不能恢复已删项`, async ({ page }) => {
    let reads = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mountWorkbench(page, async (route, key) => {
      if (key === artifact.list) {
        reads++;
        if (reads === 2) await ready;
        await route.fulfill({ json: { data: [artifact.item] } });
      } else await route.fulfill({ json: { data: [] } });
    });
    if (artifact.label !== "思维导图")
      await page.locator(".wb-tab").getByText(artifact.label, { exact: true }).click();
    await expect(page.locator(artifact.title)).toHaveText("新产物");
    const pending = invoke(page, "refresh");
    await expect.poll(() => reads).toBe(2);
    await page.locator(".workbench .delete-icon").click();
    const removed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === artifact.remove &&
        response.request().method() === "DELETE",
    );
    await page
      .locator(".confirm-dialog")
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await removed;
    await expect(page.locator(artifact.title)).toHaveCount(0);
    release();
    await pending;
    await expect(page.locator(artifact.title)).toHaveCount(0);
    expect(reads).toBe(2);
  });
}

test("切换来源文档后使用新的生成请求标识，超时旧请求不会锁住新来源", async ({ page }) => {
  const accepted: any[] = [];
  await page.route(
    (url) => url.pathname === "/src/main.ts",
    async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      body = body
        .replace(/import\s*\{\s*createApp\s*\}/, "import {createApp, ref, h}")
        .replace(/"\/src\/app\/App\.vue(?:\?[^\"]*)?"/, '"/src/features/workbench/Workbench.vue"')
        .replace(
          "createApp(App)",
          `createApp({setup(){const documentId=ref(7);window.setSource=id=>documentId.value=id;return()=>h(App,{uploadedFileName:'测试文档',uploadedDocumentId:documentId.value});}})`,
        );
      await route.fulfill({ response, body });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      if (new URL(route.request().url()).pathname === "/api/mindmaps/generate") {
        accepted.push(route.request().postDataJSON());
        return route.fulfill(
          accepted.length === 1
            ? { status: 500, json: { message: "连接中断" } }
            : { status: 202, json: { data: { taskId: 92, status: "queued" } } },
        );
      }
      await route.fulfill({ json: { data: { items: [], generationTasks: [] } } });
    },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "生成思维导图", exact: true }).click();
  await expect.poll(() => accepted.length).toBe(1);
  await page.evaluate(() => (window as any).setSource(8));
  await expect(page.getByRole("button", { name: "生成思维导图", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "生成思维导图", exact: true }).click();
  await expect.poll(() => accepted.length).toBe(2);
  expect(accepted[1].documentId).toBe(8);
  expect(accepted[1].requestId).not.toBe(accepted[0].requestId);
});
