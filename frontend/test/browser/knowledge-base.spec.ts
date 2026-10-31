import { test, expect, type Page } from "@playwright/test";

test("idle management stops polling and completed history can be cleared", async ({
  page,
}) => {
  await fixture(page);
  let history = [
    {
      id: 31,
      kind: "index",
      status: "completed",
      stage: "completed",
      completed: 1,
      total: 1,
      canDismiss: true,
    },
  ];
  let reads = 0;
  page.on("request", (req) => {
    if (
      /\/api\/(tasks\?|knowledge-bases\/1\/(documents|categories))/.test(
        req.url(),
      )
    )
      reads++;
  });
  await page.route("**/api/tasks?*", (route) => {
    if (route.request().method() === "DELETE") history = [];
    return route.fulfill({ json: { data: history } });
  });
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  await expect(page.locator(".tasks-toggle")).toContainText("1");
  await page.waitForTimeout(400);
  const initial = reads;
  await page.waitForTimeout(4500);
  expect(reads).toBe(initial);
  await page.locator(".tasks-toggle").click();
  await page.getByRole("button", { name: "清除已完成", exact: true }).click();
  await expect(page.locator(".task-row")).toHaveCount(0);
});

test("delayed cleanup shows its reason, does not poll categories, and cannot be removed", async ({
  page,
}) => {
  await fixture(page);
  let categoryReads = 0;
  page.on("request", (req) => {
    if (req.url().includes("/1/categories")) categoryReads++;
  });
  await page.route("**/api/tasks?*", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 32,
            kind: "cleanup",
            status: "queued",
            stage: "queued",
            completed: 0,
            total: null,
            canDismiss: false,
            waitingUntil: new Date(Date.now() + 600000).toISOString(),
            waitingReason: "等待索引保留期结束，保护已经开始的问答",
          },
        ],
      },
    }),
  );
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  await expect(page.locator(".task-row")).toContainText("等待索引保留期结束");
  await page.waitForTimeout(400);
  const initial = categoryReads;
  await page.waitForTimeout(2500);
  expect(categoryReads).toBe(initial);
  await expect(
    page.getByRole("button", { name: "移除记录", exact: true }),
  ).toHaveCount(0);
});

async function fixture(page: Page, interrupted = false, historical = false) {
  page.on("pageerror", (error) =>
    console.error("Browser page error:", error.message),
  );
  const state = {
    replacement: false,
    complete: false,
    failed: false,
    retried: false,
    categoryB: "not-requested" as string | null,
    analysisRequests: 0,
  };
  const citation = {
    number: 1,
    documentId: 1,
    knowledgeBaseId: 1,
    versionId: 1,
    indexRevisionId: 1,
    chunkId: 1,
    filename: "资料.md",
    text: "可核对的原文段落",
    score: 1,
    location: { page: null, paragraph: 1, heading: null, start: 0, end: 8 },
  };
  await page.addInitScript(() => {
    localStorage.setItem("token", "test-token");
    localStorage.setItem("username", "tester");
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      const body = (data: unknown, status = 200) =>
        route.fulfill({
          status,
          json: { code: 200, message: "success", data },
        });
      if (path === "/api/knowledge-bases")
        return body([
          { id: 1, name: "知识库A", description: "", rebuildTaskId: null },
          { id: 2, name: "知识库B", description: "", rebuildTaskId: null },
        ]);
      if (/\/categories$/.test(path))
        return body(
          path.includes("/1/")
            ? [{ id: 11, name: "分类A", knowledgeBaseId: 1 }]
            : [{ id: 22, name: "分类B", knowledgeBaseId: 2 }],
        );
      if (/\/knowledge-bases\/\d+\/documents$/.test(path)) {
        if (path.includes("/2/"))
          state.categoryB = url.searchParams.get("categoryId");
        const library = path.includes("/1/") ? 1 : 2;
        return body({
          items: [
            {
              id: library,
              filename: "资料.md",
              knowledgeBaseId: library,
              categoryId: null,
              status: state.failed
                ? "failed"
                : state.replacement && !state.complete
                  ? "queued"
                  : "ready",
              activeIndexRevisionId: state.complete ? 2 : 1,
              activeVersionId: state.complete ? 2 : 1,
              latestTaskId: state.replacement ? 2 : 1,
              task: {
                id: state.replacement ? 2 : 1,
                kind: "index",
                documentId: 1,
                parentTaskId: null,
                retryable: 1,
                status: state.failed
                  ? "failed"
                  : state.replacement && !state.complete
                    ? "queued"
                    : "completed",
                stage:
                  state.replacement && !state.complete ? "queued" : "completed",
                completed: state.complete ? 1 : 0,
                total: 1,
              },
            },
          ],
          total: 1,
        });
      }
      if (path === "/api/tasks") return body([]);
      if (path === "/api/tasks/2")
        return body({
          id: 2,
          status: state.failed
            ? "failed"
            : state.complete
              ? "completed"
              : "queued",
          stage: state.complete ? "completed" : "queued",
          completed: state.complete ? 1 : 0,
          total: 1,
        });
      if (path === "/api/tasks/2/retry") {
        state.failed = false;
        state.retried = true;
        return body({ id: 2, status: "queued" });
      }
      if (path === "/api/documents/1")
        return body({
          id: 1,
          filename: "资料.md",
          knowledgeBaseId: 1,
          activeIndexRevisionId: state.complete ? 2 : 1,
          activeVersionId: state.complete ? 2 : 1,
          latestTaskId: 2,
          status: state.complete ? "ready" : "queued",
        });
      if (path === "/api/chats")
        return body(
          historical
            ? [
                {
                  id: 7,
                  title: "历史问答",
                  knowledgeBaseId: 99,
                  readOnly: true,
                },
              ]
            : [],
        );
      if (path === "/api/chats/7")
        return body({
          id: 7,
          knowledgeBaseId: 99,
          readOnly: true,
          messages: [
            {
              role: "assistant",
              content: "历史结论[1]",
              citations: [{ ...citation, sourceDeleted: true }],
            },
          ],
        });
      if (path === "/api/mindmaps") return body([]);
      if (path === "/api/analysis") {
        state.analysisRequests++;
        return body([]);
      }
      if (path === "/api/upload/check")
        return body({ uploaded: false, uploadedChunks: [] });
      if (path === "/api/upload/chunk") return body({ received: true });
      if (path === "/api/upload/merge") {
        state.replacement = true;
        return body(
          { documentId: 1, taskId: 2, knowledgeBaseId: 1, filename: "资料.md" },
          202,
        );
      }
      if (path === "/api/stream-chat") {
        const sources =
          "event: sources\ndata: " + JSON.stringify([citation]) + "\n\n";
        const partial = "data: " + JSON.stringify("结论[1][99]") + "\n\n";
        const final = interrupted
          ? "event: error\ndata: " +
            JSON.stringify({
              message: "模型中断",
              answer: "结论[1]",
              citations: [citation],
              chatId: 7,
              generationStatus: "interrupted",
            }) +
            "\n\n"
          : "event: done\ndata: " +
            JSON.stringify({
              answer: "结论[1]",
              citations: [citation],
              chatId: 7,
              generationStatus: "completed",
            }) +
            "\n\n";
        return route.fulfill({
          contentType: "text/event-stream",
          body: "event: chatId\ndata: 7\n\n" + sources + partial + final,
        });
      }
      return body([]);
    },
  );
  await page.goto("/");
  await expect(
    page.getByText("问答范围：当前知识库中的可用文档"),
  ).toBeVisible();
  return state;
}

test("source selection can be cleared without changing the knowledge base", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  await page.getByRole("button", { name: "用于工作台", exact: true }).click();
  await page.locator(".el-drawer__close-btn:visible").click();
  await page.getByRole("button", { name: "取消使用", exact: true }).click();
  await expect(page.locator(".source-name")).toHaveText("在文档管理中选择文档");
  await expect(page.locator(".library-picker > .el-select")).toContainText(
    "知识库A",
  );
  await expect(
    page.getByRole("button", { name: "生成思维导图", exact: true }),
  ).toBeDisabled();
});

test("form focus has one border and drawer close icon is centered", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "新建知识库", exact: true }).click();
  const field = page.getByRole("dialog").getByLabel("名称", { exact: true });
  await field.focus();
  await expect(field).toHaveCSS("outline-style", "none");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  const close = page.locator(".knowledge-drawer .el-drawer__close-btn");
  const centered = await close.evaluate((el) => {
    const a = el.getBoundingClientRect(),
      b = el.querySelector("svg")!.getBoundingClientRect();
    return (
      Math.abs(a.x + a.width / 2 - b.x - b.width / 2) < 1 &&
      Math.abs(a.y + a.height / 2 - b.y - b.height / 2) < 1
    );
  });
  expect(centered).toBe(true);
});

test("renders the canonical assistant answer once and opens its actual citation", async ({
  page,
}) => {
  await fixture(page);
  await page.getByPlaceholder("发送消息...").fill("请说明内容");
  await page.getByPlaceholder("发送消息...").press("Enter");
  await expect(
    page.locator(".message-row.assistant .markdown-body"),
  ).toHaveText("结论[1]");
  await expect(
    page.locator(".message-row.assistant .user-content"),
  ).toHaveCount(0);
  await page.locator(".inline-citation").click();
  await expect(page.locator(".source-text")).toHaveText("可核对的原文段落");
});

test("uses the same normalized partial answer and citations when the stream fails", async ({
  page,
}) => {
  await fixture(page, true);
  await page.getByPlaceholder("发送消息...").fill("中断测试");
  await page.getByPlaceholder("发送消息...").press("Enter");
  await expect(page.locator(".interrupted-label")).toBeVisible();
  await expect(
    page.locator(".message-row.assistant .markdown-body"),
  ).toHaveText("结论[1]");
  await expect(page.locator(".citation-list button")).toHaveCount(1);
});

test("clears a previous library category before requesting documents from the next library", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  await page.locator(".filters .el-select").first().click();
  await page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: "分类A" })
    .click();
  await page.locator(".el-drawer__close-btn:visible").click();
  await page.locator(".library-picker > .el-select").click();
  await page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: "知识库B" })
    .click();
  await expect.poll(() => state.categoryB).toBeNull();
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  await expect(page.locator(".filters .el-select").first()).not.toContainText(
    "分类A",
  );
});

test("refreshes derived artifacts only after a replacement task has actually completed", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  const baseline = state.analysisRequests;
  const file = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "资料.md的更多操作" }).click();
  await page.getByRole("menuitem", { name: "替换", exact: true }).click();
  await (
    await file
  ).setFiles({
    name: "资料.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("新版来源"),
  });
  await expect.poll(() => state.replacement).toBe(true);
  await page.waitForTimeout(400);
  expect(state.analysisRequests).toBe(baseline);
  state.complete = true;
  await expect
    .poll(() => state.analysisRequests, { timeout: 6000 })
    .toBeGreaterThan(baseline);
  await page.screenshot({
    path: "test-results/knowledge-manager.png",
    fullPage: true,
  });
});

test("loads deleted-library history as read-only and starts a fresh conversation when switching libraries", async ({
  page,
}) => {
  await fixture(page, false, true);
  await page.getByText("历史问答", { exact: true }).click();
  await expect(
    page.getByText("来源知识库已删除，此会话仅可查看。"),
  ).toBeVisible();
  await expect(page.getByPlaceholder("发送消息...")).toBeDisabled();
  await page.locator(".inline-citation").click();
  await expect(
    page.getByText("来源已删除，下面展示回答时保存的原文快照。"),
  ).toBeVisible();
  await page.locator(".el-drawer__close-btn:visible").click();
  await page.locator(".library-picker > .el-select").click();
  await page
    .locator(".el-select-dropdown__item:visible")
    .filter({ hasText: "知识库B" })
    .click();
  await expect(page.getByPlaceholder("发送消息...")).toBeEnabled();
  await expect(page.locator(".message-row")).toHaveCount(0);
});

test("tracks a manually retried replacement until it publishes and refreshes the workbench", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  const baseline = state.analysisRequests;
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "资料.md的更多操作" }).click();
  await page.getByRole("menuitem", { name: "替换", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "资料.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("重试来源"),
  });
  await expect.poll(() => state.replacement).toBe(true);
  state.failed = true;
  await expect(page.getByText("更新失败，问答继续使用旧版")).toBeVisible();
  await page.screenshot({
    path: "test-results/knowledge-processing-error.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => state.retried).toBe(true);
  state.complete = true;
  await expect
    .poll(() => state.analysisRequests, { timeout: 6000 })
    .toBeGreaterThan(baseline);
});

test("knowledge management uses dark overlays and one edit form", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  const drawer = page.locator(".knowledge-drawer");
  await expect(drawer).toHaveCSS("background-color", "rgb(18, 18, 20)");
  await page.getByRole("button", { name: "知识库操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑知识库" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑知识库", exact: true });
  await expect(dialog.getByLabel("名称", { exact: true })).toHaveValue(
    "知识库A",
  );
  await expect(dialog.getByLabel("描述", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/knowledge-edit.png",
    animations: "disabled",
  });
  await dialog.getByLabel("名称", { exact: true }).fill("   ");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByText("名称须为 1～120 个字符")).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(drawer).toBeVisible();
  await page.getByRole("button", { name: "资料.md的更多操作" }).click();
  await expect(
    page.getByRole("menuitem", { name: "替换", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/knowledge-menu.png",
    animations: "disabled",
  });
});

test("knowledge drawer fits a narrow viewport without a wide table", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  await expect(page.locator(".document-card")).toBeVisible();
  await expect
    .poll(async () =>
      Math.round((await page.locator(".knowledge-drawer").boundingBox())!.x),
    )
    .toBe(0);
  const fits = await page
    .locator(".knowledge-drawer")
    .evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(fits).toBe(true);
  await page.screenshot({
    path: "test-results/knowledge-mobile.png",
    animations: "disabled",
  });
});

for (const width of [1440, 1280, 768]) {
  test(`knowledge layout fits ${width}px with readable menus`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page);
    await page.screenshot({
      path: `test-results/knowledge-entry-${width}.png`,
      animations: "disabled",
    });
    await page.locator(".library-picker > .el-select").click();
    const popper = page.locator(".el-popper.knowledge-popper:visible");
    await expect(popper).toHaveCSS("background-color", "rgb(28, 28, 31)");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "管理文档", exact: true }).click();
    await expect
      .poll(async () => {
        const box = (await page.locator(".knowledge-drawer").boundingBox())!;
        return Math.round(box.x + box.width);
      })
      .toBe(width);
    const fits = await page
      .locator(".knowledge-drawer .el-drawer__body")
      .evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(fits).toBe(true);
    await page.screenshot({
      path: `test-results/knowledge-manager-${width}.png`,
      animations: "disabled",
    });
  });
}

test("failed form saves preserve input and block duplicate submissions", async ({
  page,
}) => {
  await fixture(page);
  let submissions = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/knowledge-bases", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    submissions++;
    await pending;
    return route.fulfill({ status: 500, json: { message: "保存失败" } });
  });
  const trigger = page.getByRole("button", { name: "新建知识库", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "新建知识库", exact: true });
  await dialog.getByLabel("名称", { exact: true }).fill("我的资料库");
  await dialog.locator("form").evaluate((form) => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await expect.poll(() => submissions).toBe(1);
  await expect(
    dialog.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  release();
  await expect(dialog.getByRole("alert")).toContainText("保存失败");
  await expect(dialog.getByLabel("名称", { exact: true })).toHaveValue(
    "我的资料库",
  );
  await page.screenshot({
    path: "test-results/knowledge-form-error.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("creates a library and saves name and description together", async ({
  page,
}) => {
  await fixture(page);
  const libraries = [
    { id: 1, name: "知识库A", description: "", rebuildTaskId: null },
  ];
  let lastBody: any;
  await page.route("**/api/knowledge-bases", (route) => {
    if (route.request().method() === "POST") {
      lastBody = route.request().postDataJSON();
      const kb = {
        id: 3,
        name: lastBody.name,
        description: "",
        rebuildTaskId: null,
      };
      libraries.push(kb);
      return route.fulfill({ json: { data: kb } });
    }
    return route.fulfill({ json: { data: libraries } });
  });
  await page.route("**/api/knowledge-bases/3", (route) => {
    lastBody = route.request().postDataJSON();
    Object.assign(libraries[1], lastBody);
    return route.fulfill({ json: { data: libraries[1] } });
  });
  await page.getByRole("button", { name: "新建知识库", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建知识库", exact: true });
  await create.getByLabel("名称", { exact: true }).fill("论文资料");
  await create.getByRole("button", { name: "保存", exact: true }).click();
  await expect(create).not.toBeVisible();
  await expect(page.locator(".library-picker > .el-select")).toContainText(
    "论文资料",
  );
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  await page.getByRole("button", { name: "知识库操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑知识库" }).click();
  const edit = page.getByRole("dialog", { name: "编辑知识库", exact: true });
  await edit.getByLabel("名称", { exact: true }).fill("毕业设计");
  await edit.getByLabel("描述", { exact: true }).fill("收集答辩资料");
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await expect(edit).not.toBeVisible();
  expect(lastBody).toEqual({ name: "毕业设计", description: "收集答辩资料" });
  await expect(page.locator(".manager-heading h2")).toHaveText("毕业设计");
  await expect(page.locator(".manager-heading p")).toHaveText("收集答辩资料");
});

test("upload pause, resume and cancel retain their controls", async ({
  page,
}) => {
  await fixture(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/upload/chunk", async (route) => {
    await pending;
    await route
      .fulfill({ json: { data: { received: true } } })
      .catch(() => undefined);
  });
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传文档", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "新资料.md",
    mimeType: "text/markdown",
    buffer: Buffer.alloc(100, "a"),
  });
  await page.getByRole("button", { name: "暂停上传", exact: true }).click();
  await expect(
    page.getByText("上传已暂停，可随时继续", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续上传", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "暂停上传", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "取消（保留已传分片）", exact: true })
    .click();
  release();
  await expect(
    page.getByRole("button", { name: "上传文档", exact: true }),
  ).toBeVisible();
});

test("category forms and document deletion use themed confirmations", async ({
  page,
}) => {
  await fixture(page);
  let categories = [{ id: 11, name: "分类A", knowledgeBaseId: 1 }];
  await page.route("**/api/knowledge-bases/1/categories", (route) => {
    if (route.request().method() === "POST")
      categories.push({
        id: 12,
        name: route.request().postDataJSON().name,
        knowledgeBaseId: 1,
      });
    return route.fulfill({ json: { data: categories } });
  });
  await page.route("**/api/knowledge-bases/1/categories/12", (route) => {
    if (route.request().method() === "DELETE")
      categories = categories.filter((c) => c.id !== 12);
    else categories[1].name = route.request().postDataJSON().name;
    return route.fulfill({ json: { data: {} } });
  });
  let deleted = false;
  await page.route("**/api/documents/1", (route) => {
    if (route.request().method() === "DELETE") deleted = true;
    return route.fulfill({ json: { data: { taskId: 3 } } });
  });
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  await page.getByRole("button", { name: "添加分类", exact: true }).click();
  const add = page.getByRole("dialog", { name: "添加分类", exact: true });
  await add.getByLabel("名称", { exact: true }).fill("研究资料");
  await add.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑分类研究资料" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "编辑分类研究资料" }).click();
  const edit = page.getByRole("dialog", { name: "修改分类", exact: true });
  await edit.getByLabel("名称", { exact: true }).fill("答辩资料");
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "删除分类答辩资料" }).click();
  const confirm = page.locator(".knowledge-confirm");
  await expect(confirm).toHaveCSS("background-color", "rgb(28, 28, 31)");
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑分类答辩资料" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "资料.md的更多操作" }).click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await expect(confirm).toContainText("历史聊天引用会保留");
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  expect(deleted).toBe(false);
  await page.getByRole("button", { name: "资料.md的更多操作" }).click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => deleted).toBe(true);
});

test("empty states and task failures remain useful without clearing current documents", async ({
  page,
}) => {
  await fixture(page);
  let unavailable = false;
  await page.route("**/api/knowledge-bases/1/documents?*", (route) => {
    if (unavailable)
      return route.fulfill({ status: 503, json: { message: "暂时不可用" } });
    return route.fulfill({ json: { data: { items: [], total: 0 } } });
  });
  await page.route("**/api/tasks?*", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 99,
            kind: "rebuild",
            status: "partial_failed",
            stage: "partial_failed",
            completed: 1,
            total: 2,
            retryable: 1,
            error: "一份文档未完成",
          },
        ],
      },
    }),
  );
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  await expect(page.getByText("知识库还是空的", { exact: true })).toBeVisible();
  await page.getByPlaceholder("搜索文件名").fill("找不到的文件");
  await expect(
    page.getByText("没有找到匹配的文档", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".task-list")).toContainText("部分失败");
  await expect(
    page
      .locator(".task-list")
      .getByRole("button", { name: "重试", exact: true }),
  ).toBeVisible();
  unavailable = true;
  await page.getByRole("button", { name: "刷新文档", exact: true }).click();
  await expect(page.locator(".load-error")).toContainText("暂时无法更新文档");
  await expect(page.locator(".task-list")).toContainText("部分失败");
});
