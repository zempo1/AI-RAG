import { test, expect } from "@playwright/test";
import { quizFixture, openQuiz } from "./quiz-fixture";

test("智能测验在选中来源尚未就绪时禁用生成并在完成后恢复", async ({ page }) => {
  const state = await quizFixture(page);
  state.sourceReady = false;
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  await page.getByRole("button", { name: "用于工作台", exact: true }).click();
  await page.locator(".el-drawer__close-btn:visible").click();
  await expect(page.getByRole("button", { name: "生成智能测验", exact: true })).toBeDisabled();
  await expect(page.getByText("文档尚未就绪，处理完成后即可生成。", { exact: true })).toBeVisible();
  state.sourceReady = true;
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  await page.getByRole("button", { name: "刷新文档", exact: true }).click();
  await expect(page.locator(".document-card").first()).toContainText("已就绪");
  await page.locator(".el-drawer__close-btn:visible").click();
  await expect(page.getByRole("button", { name: "生成智能测验", exact: true })).toBeEnabled();
});

test("智能测验逐题判分、刷新恢复、多选草稿和重练记录", async ({ page }) => {
  const state = await quizFixture(page);
  await openQuiz(page);
  await expect(page.locator(".quiz-option-explanation")).toHaveCount(0);
  await page.getByRole("radio", { name: /A 在相邻节点/ }).click();
  await expect(page.locator(".quiz-feedback")).toContainText("回答正确");
  await page.getByRole("button", { name: "下一题", exact: false }).click();
  await page.getByRole("checkbox", { name: /A 帧同步/ }).click();
  await expect(page.locator(".quiz-save-state")).toHaveText("进度已保存");
  await page.reload();
  await page.locator(".wb-tab").getByText("智能测验", { exact: true }).click();
  await page.getByRole("button", { name: "继续练习", exact: false }).click();
  await expect(page.locator(".quiz-question-stem")).toContainText("哪些机制");
  await expect(page.getByRole("checkbox", { name: /A 帧同步/ })).toBeChecked();
  await expect(page.locator(".quiz-option-explanation")).toHaveCount(0);
  await page.getByRole("checkbox", { name: /B 差错检测/ }).click();
  await page.getByRole("button", { name: "提交答案", exact: true }).click();
  await expect(page.locator(".quiz-result-score")).toContainText("100");
  await page.getByRole("button", { name: "查看全部解析", exact: true }).click();
  await expect(page.locator(".quiz-save-state")).toHaveText("进度已保存");
  await expect(page.locator(".quiz-question-stem")).toContainText("主要功能");
  await page.getByRole("button", { name: "查看成绩", exact: true }).click();
  const original = state.attempt().id;
  await page.getByRole("button", { name: "重新练习", exact: true }).click();
  await expect(page.locator(".quiz-question-stem")).toContainText("主要功能");
  expect(state.attempt().id).toBeGreaterThan(original);
  await expect(page.locator(".quiz-option-explanation")).toHaveCount(0);
  await page.getByLabel("练习记录").selectOption(String(original));
  await expect(page.locator(".quiz-result-score")).toContainText("100");
  await expect(page.getByLabel("练习记录")).toHaveValue(String(original));
});
test("智能测验解释限定文档、保留聊天草稿并恢复全屏宽度", async ({ page }) => {
  const state = await quizFixture(page);
  await openQuiz(page);
  await page.getByPlaceholder("发送消息...").fill("保留的输入草稿");
  await page.getByRole("radio", { name: /A 在相邻节点/ }).click();
  await expect(page.locator(".quiz-feedback")).toBeVisible();
  await page.screenshot({ path: "../.shared/quiz-implementation/quiz-panel.png" });
  const width = (await page.locator(".quiz-panel").boundingBox())!.width;
  await page.getByRole("button", { name: "全屏展示测验", exact: true }).click();
  await expect(page.locator(".quiz-panel")).toHaveClass(/is-fullscreen/);
  await page.getByRole("button", { name: "解释", exact: true }).click();
  await expect(page.locator(".quiz-panel")).not.toHaveClass(/is-fullscreen/);
  await expect(page.locator(".markdown-body").last()).toContainText("帧传输");
  await expect(page.getByPlaceholder("发送消息...")).toHaveValue("保留的输入草稿");
  expect(state.streamRequests[0]).toMatchObject({
    knowledgeBaseId: 1,
    documentIds: [7],
    mode: "search",
    quizContext: { attemptId: 101, questionId: "q1" },
  });
  expect(state.streamRequests[0].question).toContain("我选择了：A");
  expect((await page.locator(".quiz-panel").boundingBox())!.width).toBeCloseTo(width, 0);
  await page.getByRole("button", { name: "全屏展示测验", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".quiz-panel")).not.toHaveClass(/is-fullscreen/);
});

test("智能测验生成弹窗支持混合配比并自动打开生成结果", async ({ page }) => {
  const state = await quizFixture(page);
  await page.getByRole("button", { name: "管理文档", exact: true }).click();
  await page.getByRole("button", { name: "用于工作台", exact: true }).click();
  const manager = page.getByRole("dialog");
  await manager.getByRole("button", { name: /Close this dialog|关闭此对话框/ }).click();
  await page.getByRole("button", { name: "生成智能测验", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "生成智能测验" });
  await dialog.locator(".el-input-number input").fill("10");
  await dialog.locator(".el-input-number input").press("Tab");
  const slider = dialog.getByRole("slider");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator(".quiz-ratio-field")).toContainText("单选 6 道");
  await page.screenshot({
    path: "../.shared/quiz-implementation/quiz-config.png",
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "开始生成", exact: true }).click();
  await expect.poll(() => state.generationRequests.length).toBe(1);
  expect(state.generationRequests[0]).toMatchObject({
    documentId: 7,
    singleCount: 6,
    multipleCount: 4,
  });
  await expect(page.locator(".quiz-panel")).toBeVisible({ timeout: 10000 });
});
test("智能测验保存失败保留选择并提供重试", async ({ page }) => {
  const state = await quizFixture(page);
  await openQuiz(page);
  state.failSave = true;
  await page.getByRole("button", { name: "第 2 题", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试保存" })).toBeVisible();
  state.failSave = false;
  await page.getByRole("button", { name: "重试保存" }).click();
  await page.getByRole("checkbox", { name: /A 帧同步/ }).click();
  await expect(page.getByRole("checkbox", { name: /A 帧同步/ })).toBeChecked();
  await expect(page.locator(".quiz-save-state")).toHaveText("进度已保存");
  expect(state.attempt().answers.q2).toMatchObject({ selectedOptionIds: ["A"], submitted: false });
});
test("智能测验窄屏解释后可返回原题且无横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await quizFixture(page);
  await openQuiz(page);
  await expect(page.getByRole("separator")).toHaveCount(0);
  await page.getByRole("radio", { name: /A 在相邻节点/ }).click();
  await expect(page.locator(".quiz-feedback")).toBeVisible();
  await page.getByRole("button", { name: "解释", exact: true }).click();
  await expect(page.getByRole("button", { name: "返回测验", exact: true })).toBeVisible();
  await expect(page.locator(".quiz-panel")).toBeHidden();
  await page.getByRole("button", { name: "返回测验", exact: true }).click();
  await expect(page.locator(".quiz-feedback")).toContainText("回答正确");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
