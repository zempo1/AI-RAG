import { test, expect, type Page, type Route } from '@playwright/test';

const analysis = (documentName: string) => ({
  id: 21, documentId: 7, documentName, type: 'SUMMARY',
  content: '摘要正文', createdAt: '2026-11-15T01:00:00Z',
});

// 使用真实工作台及其公开接口，只有外部 API 被替换；复用 Vite 已解析的依赖。
async function mountWorkbench(page: Page, handle: (route: Route, key: string) => Promise<void>) {
  await page.route(url => url.pathname === '/src/main.ts', async route => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace(/"\/src\/app\/App\.vue(?:\?[^\"]*)?"/, '"/src/features/workbench/Workbench.vue"')
      .replace('createApp(App)', 'createApp(App, { uploadedFileName: "测试资料", uploadedDocumentId: 7 })')
      .replace('app.mount("#app")', 'window.workbench = app.mount("#app")');
    await route.fulfill({ response, body });
  });
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const url = new URL(route.request().url());
    return handle(route, url.pathname + url.search);
  });
  await page.goto('/');
  await expect(page.locator('.workbench')).toBeVisible();
}

async function invoke(page: Page, method: 'refresh' | 'onSourceDeleted' | 'loadSummaries', argument?: number) {
  await page.evaluate(async ({ method, argument }) => {
    await (window as any).workbench[method](argument);
  }, { method, argument });
}

test('刷新仅重取当前标签，其余已访问标签在下次打开时更新', async ({ page }) => {
  const counts = new Map<string, number>();
  await mountWorkbench(page, async (route, key) => {
    counts.set(key, (counts.get(key) || 0) + 1);
    await route.fulfill({ json: { data: [] } });
  });
  await expect(page.getByText('暂无思维导图', { exact: true })).toBeVisible();
  await page.locator('.wb-tab').getByText('AI 摘要', { exact: true }).click();
  await expect(page.getByText('暂无摘要记录', { exact: true })).toBeVisible();
  await invoke(page, 'refresh');
  expect(counts.get('/api/mindmaps')).toBe(1);
  expect(counts.get('/api/analysis?type=SUMMARY')).toBe(2);
  expect(counts.has('/api/analysis?type=OUTLINE')).toBe(false);
  expect(counts.has('/api/analysis?type=FLASHCARD')).toBe(false);
  await page.locator('.wb-tab').getByText('思维导图', { exact: true }).click();
  await expect.poll(() => counts.get('/api/mindmaps')).toBe(2);
  await page.locator('.wb-tab').getByText('AI 摘要', { exact: true }).click();
  await expect(page.getByText('暂无摘要记录', { exact: true })).toBeVisible();
  expect(counts.get('/api/analysis?type=SUMMARY')).toBe(2);
});

test('标签加载失败后重新切换会重试并显示结果', async ({ page }) => {
  let attempts = 0;
  await mountWorkbench(page, async (route, key) => {
    if (key === '/api/analysis?type=SUMMARY') {
      attempts++;
      await route.fulfill(attempts === 1
        ? { status: 500, json: { message: '暂时不可用' } }
        : { json: { data: [analysis('重试后摘要')] } });
    } else await route.fulfill({ json: { data: [] } });
  });
  await page.locator('.wb-tab').getByText('AI 摘要', { exact: true }).click();
  await expect(page.getByText('暂无摘要记录', { exact: true })).toBeVisible();
  await page.locator('.wb-tab').getByText('思维导图', { exact: true }).click();
  await page.locator('.wb-tab').getByText('AI 摘要', { exact: true }).click();
  await expect(page.locator('.analysis-doc')).toHaveText('重试后摘要');
  expect(attempts).toBe(2);
});

test('同一标签的并发读取复用在途请求', async ({ page }) => {
  let requests = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await mountWorkbench(page, async (route, key) => {
    if (key === '/api/analysis?type=SUMMARY') {
      requests++;
      await ready;
      await route.fulfill({ json: { data: [analysis('共享加载结果')] } });
    } else await route.fulfill({ json: { data: [] } });
  });
  await page.locator('.wb-tab').getByText('AI 摘要', { exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await page.locator('.wb-tab').getByText('思维导图', { exact: true }).click();
  await page.locator('.wb-tab').getByText('AI 摘要', { exact: true }).click();
  const pending = page.evaluate(async () => {
    await Promise.all([(window as any).workbench.loadSummaries(), (window as any).workbench.loadSummaries()]);
  });
  await expect(page.getByText('加载中…', { exact: true })).toBeVisible();
  release();
  await pending;
  await expect(page.locator('.analysis-doc')).toHaveText('共享加载结果');
  expect(requests).toBe(1);
});

test('刷新后完成的过期请求不会覆盖新结果', async ({ page }) => {
  let requests = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await mountWorkbench(page, async (route, key) => {
    if (key === '/api/analysis?type=SUMMARY') {
      requests++;
      const first = requests === 1;
      if (first) await ready;
      await route.fulfill({ json: { data: [analysis(first ? '过期摘要' : '刷新后摘要')] } });
    } else await route.fulfill({ json: { data: [] } });
  });
  await page.locator('.wb-tab').getByText('AI 摘要', { exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await invoke(page, 'refresh');
  await expect(page.locator('.analysis-doc')).toHaveText('刷新后摘要');
  const oldResponse = page.waitForResponse(response => response.url().includes('/api/analysis?type=SUMMARY'));
  release();
  await oldResponse;
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.analysis-doc')).toHaveText('刷新后摘要');
});

test('删除来源只刷新当前标签，未打开的标签保持按需读取', async ({ page }) => {
  const counts = new Map<string, number>();
  await mountWorkbench(page, async (route, key) => {
    counts.set(key, (counts.get(key) || 0) + 1);
    await route.fulfill({ json: { data: [] } });
  });
  await expect(page.getByText('暂无思维导图', { exact: true })).toBeVisible();
  await invoke(page, 'onSourceDeleted', 7);
  expect(counts.get('/api/mindmaps')).toBe(2);
  expect(counts.has('/api/analysis?type=SUMMARY')).toBe(false);
  expect(counts.has('/api/analysis?type=OUTLINE')).toBe(false);
  expect(counts.has('/api/analysis?type=FLASHCARD')).toBe(false);
  await page.locator('.wb-tab').getByText('文档大纲', { exact: true }).click();
  await expect(page.getByText('暂无大纲记录', { exact: true })).toBeVisible();
  expect(counts.get('/api/analysis?type=OUTLINE')).toBe(1);
});

const artifactTabs = [
  { label: '思维导图', list: '/api/mindmaps', generate: '/api/mindmaps/generate', remove: '/api/mindmaps/21',
    button: '生成思维导图', title: '.map-title', item: { id: 21, documentId: 7, title: '新产物', data: '{"data":{"text":"根节点"}}', createdAt: '2026-11-15T01:00:00Z' } },
  { label: 'AI 摘要', list: '/api/analysis?type=SUMMARY', generate: '/api/analysis/generate', remove: '/api/analysis/21',
    button: '生成 AI 摘要', title: '.analysis-doc', item: analysis('新产物') },
  { label: '文档大纲', list: '/api/analysis?type=OUTLINE', generate: '/api/analysis/generate', remove: '/api/analysis/21',
    button: '生成文档大纲', title: '.analysis-doc', item: { ...analysis('新产物'), type: 'OUTLINE' } },
  { label: '学习卡片', list: '/api/analysis?type=FLASHCARD', generate: '/api/analysis/generate', remove: '/api/analysis/21',
    button: '生成学习卡片', title: '.map-title', item: { ...analysis('新产物'), type: 'FLASHCARD', content: '[{"q":"问题","a":"答案"}]' } },
];

for (const artifact of artifactTabs) {
  test(`${artifact.label}生成成功使生成前在途列表失效`, async ({ page }) => {
    let reads = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    await mountWorkbench(page, async (route, key) => {
      if (key === artifact.list) {
        reads++;
        const first = reads === 1;
        if (first) await ready;
        await route.fulfill({ json: { data: first ? [] : [artifact.item] } });
      } else if (key === artifact.generate) {
        await route.fulfill({ json: { data: artifact.item } });
      } else await route.fulfill({ json: { data: [] } });
    });
    if (artifact.label !== '思维导图') await page.locator('.wb-tab').getByText(artifact.label, { exact: true }).click();
    await expect.poll(() => reads).toBe(1);
    try {
      await page.getByRole('button', { name: artifact.button, exact: true }).click();
      await expect.poll(() => reads).toBe(2);
      await expect(page.locator(artifact.title)).toHaveText('新产物');
    } finally { release(); }
    await page.waitForLoadState('networkidle');
    await expect(page.locator(artifact.title)).toHaveText('新产物');
  });

  test(`${artifact.label}删除后在途旧列表不能恢复已删项`, async ({ page }) => {
    let reads = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    await mountWorkbench(page, async (route, key) => {
      if (key === artifact.list) {
        reads++;
        if (reads === 2) await ready;
        await route.fulfill({ json: { data: [artifact.item] } });
      } else await route.fulfill({ json: { data: [] } });
    });
    if (artifact.label !== '思维导图') await page.locator('.wb-tab').getByText(artifact.label, { exact: true }).click();
    await expect(page.locator(artifact.title)).toHaveText('新产物');
    const pending = invoke(page, 'refresh');
    await expect.poll(() => reads).toBe(2);
    await page.locator('.workbench .delete-icon').click();
    const removed = page.waitForResponse(response => new URL(response.url()).pathname === artifact.remove && response.request().method() === 'DELETE');
    await page.locator('.confirm-dialog').getByRole('button', { name: '删除', exact: true }).click();
    await removed;
    await expect(page.locator(artifact.title)).toHaveCount(0);
    release();
    await pending;
    await expect(page.locator(artifact.title)).toHaveCount(0);
    expect(reads).toBe(2);
  });
}
