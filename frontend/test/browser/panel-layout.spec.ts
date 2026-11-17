import { test, expect } from "@playwright/test";
import { quizFixture, openQuiz } from "./quiz-fixture";

test("面板调宽分别记住测验与来源宽度并在返回原题时恢复", async ({ page }) => {
  await quizFixture(page);
  await openQuiz(page);
  const right = page.getByRole("separator", { name: "调整右侧面板宽度" });
  await right.focus();
  await page.keyboard.press("ArrowLeft");
  const quizWidth = (await page.locator(".quiz-panel").boundingBox())!.width;
  await page.locator(".quiz-source-link").click();
  await expect(page.getByRole("region", { name: "文档阅读器" })).toBeVisible();
  await expect(right).toHaveAttribute("aria-controls", "panel-reader");
  await right.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const readerWidth = (await page.locator(".source-panel").boundingBox())!.width;
  await page.getByRole("button", { name: "关闭阅读器", exact: true }).click();
  expect((await page.locator(".quiz-panel").boundingBox())!.width).toBeCloseTo(quizWidth, 0);
  await expect(page.locator(".quiz-question-stem")).toContainText("主要功能");
  await page.locator(".quiz-source-link").click();
  await expect(page.locator(".source-panel")).toBeVisible();
  expect((await page.locator(".source-panel").boundingBox())!.width).toBeCloseTo(readerWidth, 0);
});

test("面板调宽适用于导图且全屏往返保留调整宽度", async ({ page }) => {
  await quizFixture(page);
  await page.route("**/api/mindmaps/workspace*", (route) =>
    route.fulfill({
      json: {
        data: {
          items: [{ id: 31, title: "网络导图", createdAt: "2026-11-17" }],
          generationTasks: [],
        },
      },
    }),
  );
  await page.route("**/api/mindmaps/31", (route) =>
    route.fulfill({
      json: {
        data: {
          id: 31,
          title: "网络导图",
          documentId: 7,
          data: JSON.stringify({
            root: {
              data: { text: "网络原理" },
              children: [{ data: { text: "数据链路层" }, children: [] }],
            },
          }),
        },
      },
    }),
  );
  // Reload after replacing the startup workspace fixture: the workbench correctly caches its first load.
  await page.reload();
  await page.locator(".wb-tab").getByText("思维导图", { exact: true }).click();
  await page.getByText("网络导图", { exact: true }).click();
  await expect(page.getByRole("region", { name: "思维导图编辑器" })).toBeVisible();
  const right = page.getByRole("separator", { name: "调整右侧面板宽度" });
  await expect(right).toHaveAttribute("aria-controls", "panel-mindmap");
  await right.focus();
  await page.keyboard.press("ArrowLeft");
  const width = (await page.locator(".mindmap-panel").boundingBox())!.width;
  await page.getByRole("button", { name: "全屏", exact: true }).click();
  await expect(page.getByRole("separator")).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect((await page.locator(".mindmap-panel").boundingBox())!.width).toBeCloseTo(width, 0);
  await expect(page.locator(".mindmap-canvas svg")).toBeVisible();
});

test("面板调宽支持双侧拖拽、键盘、复位和刷新记忆", async ({ page }) => {
  await quizFixture(page);
  const left = page.getByRole("separator", { name: "调整文档侧栏宽度" }),
    right = page.getByRole("separator", { name: "调整右侧面板宽度" });
  await left.focus();
  await page.keyboard.press("ArrowRight");
  await expect(left).toHaveAttribute("aria-valuenow", "316");
  const box = (await right.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 3 - 120, box.y + 40);
  await page.mouse.up();
  await expect(right).toHaveAttribute("aria-valuenow", "420");
  await page.reload();
  await expect(left).toHaveAttribute("aria-valuenow", "316");
  await expect(right).toHaveAttribute("aria-valuenow", "420");
  await right.focus();
  await page.keyboard.press("End");
  await expect(right).toHaveAttribute("aria-valuenow", "480");
  await right.dblclick({ position: { x: 3, y: 40 } });
  await expect(right).toHaveAttribute("aria-valuenow", "300");
});
test("面板调宽在测验中保护聊天最小宽度、全屏恢复并支持键盘调宽", async ({ page }) => {
  await quizFixture(page);
  await openQuiz(page);
  const right = page.getByRole("separator", { name: "调整右侧面板宽度" });
  await right.focus();
  await page.keyboard.press("End");
  const chat = (await page.locator(".main-content").boundingBox())!;
  expect(chat.width).toBeGreaterThanOrEqual(360);
  const width = (await page.locator(".quiz-panel").boundingBox())!.width;
  await page.getByRole("button", { name: "全屏展示测验", exact: true }).click();
  await expect(page.getByRole("separator")).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect((await page.locator(".quiz-panel").boundingBox())!.width).toBeCloseTo(width, 0);
  await right.focus();
  await page.keyboard.press("ArrowRight");
  expect((await page.locator(".quiz-panel").boundingBox())!.width).toBeCloseTo(width - 16, 0);
});
