import { test, expect } from "@playwright/test";
test("导图先在右侧编辑，全屏往返保留布局并支持展开收起保存", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("token", "test"));
  let saved: any;
  let mapReads = 0;
  let generationCalls = 0;
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/mindmaps/generate") generationCalls++;
      let data: any = [];
      if (path === "/api/knowledge-bases")
        data = [
          { id: 1, name: "测试知识库" },
          { id: 2, name: "第二知识库" },
        ];
      if (path.endsWith("/documents")) data = { items: [], total: 0 };
      if (path === "/api/mindmaps/workspace")
        data = {
          items: [{ id: 7, title: "全文导图", createdAt: "2026-11-15", documentId: 1 }],
          generationTasks: [],
        };
      if (path === "/api/mindmaps/7") {
        if (route.request().method() === "GET") mapReads++;
        if (route.request().method() === "PUT") {
          saved = JSON.parse(route.request().postDataJSON().data);
          data = { id: 7, data: JSON.stringify(saved) };
        } else
          data = {
            id: 7,
            title: "全文导图",
            data: JSON.stringify({
              meta: {
                assembly: { organization: "source-order", omittedTopics: 0, omittedPoints: 0 },
              },
              root: {
                data: { text: "主题" },
                children: [{ data: { text: "章节" }, children: [{ data: { text: "知识点" } }] }],
              },
            }),
          };
      }
      await route.fulfill({ json: { data } });
    },
  );
  await page.goto("/");
  await page.getByText("全文导图", { exact: true }).click();
  const panel = page.getByRole("region", { name: "思维导图编辑器" });
  await expect(panel).toBeVisible();
  await expect(panel.locator("svg").first()).toBeVisible();
  await expect(panel).toContainText("已按来源顺序组织知识点");
  await page.getByRole("button", { name: "全部收起", exact: true }).click();
  await expect(panel.locator(".smm-node").filter({ hasText: "知识点" })).toHaveCount(0);
  await expect(panel.locator(".dirty-state")).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
  await page.getByRole("button", { name: "关闭思维导图" }).click();
  await expect(panel).toHaveCount(0);
  await page.getByText("全文导图", { exact: true }).click();
  await expect(panel.locator("svg").first()).toBeVisible();
  await page.getByRole("button", { name: "全部展开", exact: true }).click();
  await panel.locator(".smm-node").filter({ hasText: "知识点" }).dblclick();
  const textEditor = page.locator('[contenteditable="true"]');
  await textEditor.fill("修改后的知识点");
  expect(
    await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }),
  ).toBe(true);
  await textEditor.press("Enter");
  await page.getByRole("button", { name: "导图布局", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "组织结构图" })).toBeVisible();
  await page.screenshot({ path: "test-results/mindmap-layout-preview.png" });
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "组织结构图" })).not.toBeVisible();
  await page.getByRole("button", { name: "导图布局", exact: true }).click();
  await page.getByRole("menuitem", { name: "组织结构图" }).click();
  await expect(page.getByRole("button", { name: "导图布局", exact: true })).toContainText(
    "组织结构图",
  );
  await page.getByRole("button", { name: "导图布局", exact: true }).click();
  await page.getByRole("menuitem", { name: "逻辑结构图" }).click();
  const initial = await panel.boundingBox();
  expect(initial!.x).toBeGreaterThan(200);
  await page.getByRole("button", { name: "全部收起", exact: true }).click();
  await expect(panel.locator(".smm-node").filter({ hasText: "知识点" })).toHaveCount(0);
  await page.getByRole("button", { name: "全部展开", exact: true }).click();
  await expect(panel.locator(".smm-node").filter({ hasText: "知识点" })).toBeVisible();
  expect(mapReads).toBe(2);
  expect(generationCalls).toBe(0);
  await page.getByRole("button", { name: "全屏", exact: true }).click();
  await expect(panel).toHaveClass(/is-fullscreen/);
  await page.keyboard.press("Escape");
  await expect(panel).not.toHaveClass(/is-fullscreen/);
  const download = page.waitForEvent("download");

  await page.getByRole("button", { name: "导出 PNG", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("全文导图.png");

  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect.poll(() => saved?.schemaVersion).toBe(2);
  expect(saved.root.children[0].children[0].data.text).toBe("修改后的知识点");

  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await panel.locator(".smm-node").filter({ hasText: "修改后的知识点" }).dblclick();

  await textEditor.fill("再次修改的知识点");
  await textEditor.press("Enter");

  await page.getByRole("button", { name: "全部收起", exact: true }).click();
  await page.getByRole("button", { name: "关闭思维导图" }).click();
  const confirm = page.getByRole("dialog", { name: "保存思维导图更改" });
  await expect(confirm).toBeVisible();
  const card = confirm.locator(".mindmap-confirm-card");
  await expect(card).toBeVisible();
  expect((await card.boundingBox())!.width).toBeLessThanOrEqual(440);
  await page.screenshot({ path: "test-results/mindmap-confirm-preview.png" });
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "关闭思维导图" }).click();
  await confirm.getByRole("button", { name: "保存并继续" }).click();
  await expect(panel).toHaveCount(0);
  expect(saved.root.children[0].data.expand).toBe(false);
  await page.getByText("全文导图", { exact: true }).click();
  await expect(panel.locator("svg").first()).toBeVisible();
  await page.getByRole("button", { name: "全部收起", exact: true }).click();
  await page.getByRole("button", { name: "导图布局", exact: true }).click();
  await page.getByRole("menuitem", { name: "时间轴", exact: true }).click();
  await page.locator(".library-picker .el-select").click();
  await page.getByText("第二知识库", { exact: true }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "放弃更改" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(panel).toHaveCount(0);
});

test("刷新后找回后台任务，完成只显示结果入口，不抢占阅读区域", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("token", "test"));
  let completed = false,
    polls = 0;
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data: any = [];
      const task = {
        id: 99,
        kind: "mindmap",
        documentId: 1,
        status: completed ? "completed" : "running",
        stage: completed ? "completed" : "mapping",
        completed: completed ? 2 : 1,
        total: 2,
        retryable: 1,
        error: null,
        ...(completed ? { mindmapResult: { mindMapId: 7 } } : {}),
      };
      if (path === "/api/knowledge-bases") data = [{ id: 1, name: "测试库" }];
      if (path.endsWith("/documents")) data = { items: [], total: 0 };
      if (path === "/api/mindmaps/workspace") data = { items: [], generationTasks: [task] };
      if (path === "/api/tasks/99") {
        polls++;
        completed = true;
        data = {
          ...task,
          status: "completed",
          stage: "completed",
          mindmapResult: { mindMapId: 7 },
        };
      }
      await route.fulfill({ json: { data } });
    },
  );
  await page.goto("/");
  await expect(page.getByText("提炼要点")).toBeVisible();
  await expect(page.locator(".generation-tasks")).toHaveCount(0);
  expect(polls).toBe(1);
  await expect(page.getByRole("region", { name: "思维导图编辑器" })).toHaveCount(0);
});
