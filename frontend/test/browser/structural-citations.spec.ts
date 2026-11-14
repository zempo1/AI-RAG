import { test, expect, type Page } from '@playwright/test';

const location = (start = 0, end = 20) => ({
  page: 1, paragraph: 1, heading: '实习经历', start, end,
  anchorVersion: 1,
  anchors: [{ page: 1, start, end, rects: [[.1, .1, .8, .2]], kind: 'native' }],
});
const candidates = Array.from({ length: 102 }, (_, index) => ({
  number: index + 1, documentId: 1, knowledgeBaseId: 1, versionId: 11,
  indexRevisionId: 21, chunkId: index + 1, filename: '结构引用.pdf',
  text: `检索候选碎片 ${index + 1}`, score: 1, location: location(),
}));
const citations = [
  { ...candidates[2], sectionTitle: '杭州实习', text: '杭州实习完整第一段\n杭州实习完整第二段',
    location: { ...location(0, 100), anchors: [...location(0, 20).anchors, ...location(80, 100).anchors] },
    sourceSegments: [
      { text: '杭州实习完整第一段', location: location(0, 20), chunkIds: [3] },
      { text: '杭州实习完整第二段', location: location(80, 100), chunkIds: [4] },
    ] },
  { ...candidates[19], location: { ...location(), heading: '佛山实习' } },
  { ...candidates[59], text: '跨页 RAG 项目完整说明', location: { ...location(), heading: null } },
  { ...candidates[100], sectionTitle: '研究项目' },
];
const answer = '两段实习 [3] [20]，两个项目 [60] [101]。';
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

async function fixture(page: Page, historical = false) {
  await page.addInitScript(() => localStorage.setItem('token', 'test-token'));
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path === '/api/knowledge-bases') data = [{ id: 1, name: '结构测试', rebuildTaskId: null }];
    if (path.endsWith('/documents')) data = { items: [], total: 0 };
    if (path === '/api/chats') data = historical ? [{ id: 7, title: '结构引用历史', knowledgeBaseId: 1 }] : [];
    if (path === '/api/chats/7') data = { id: 7, knowledgeBaseId: 1, pendingTasks: [], messages: [
      { role: 'assistant', content: answer, citations, generationStatus: 'completed' },
    ] };
    if (path.endsWith('/preview')) data = { documentId: 1, versionId: 11, filename: '结构引用.pdf',
      mimeType: 'application/pdf', originalAvailable: false, originalUrl: null };
    if (path.endsWith('/citation-context')) data = { text: `无关的相邻段落\n${citations[0].text}\n其他实习经历` };
    return route.fulfill({ json: { data } });
  });
  await page.goto('/');
  await expect(page.getByPlaceholder('发送消息...')).toBeEnabled();
}

async function ask(page: Page) {
  await page.getByPlaceholder('发送消息...').fill('按实习和项目整理');
  await page.getByPlaceholder('发送消息...').press('Enter');
}

test('102 个 SSE 检索候选最终只展示 4 个完整引用，段落标签和编号可打开原文', async ({ page }, testInfo) => {
  await fixture(page);
  await page.route('**/api/stream-chat', route => route.fulfill({ contentType: 'text/event-stream', body:
    event('sources', candidates) + event('done', { answer, citations, chatId: 7, generationStatus: 'completed' }) }));
  await ask(page);
  await expect(page.locator('.markdown-body')).toContainText('两段实习');
  const references = page.locator('.retrieved-sources');
  await expect(references.locator('summary')).toHaveText('参考段落（4）');
  await expect(references).not.toHaveAttribute('open');
  await references.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(references.getByRole('button')).toHaveCount(4);
  await expect(references.getByRole('button')).toHaveText([
    '[3] 结构引用.pdf · 杭州实习', '[20] 结构引用.pdf · 佛山实习',
    '[60] 结构引用.pdf · 跨页 RAG 项目完整说明', '[101] 结构引用.pdf · 研究项目',
  ]);
  await page.screenshot({ path: testInfo.outputPath('four-reference-paragraphs.png') });
  await references.getByRole('button').first().click();
  await expect(page.getByRole('region', { name: '文档阅读器' }).locator('.source-text')).toContainText('杭州实习完整第二段');
  await page.getByRole('button', { name: '关闭阅读器' }).click();
  await page.locator('[data-citation="20"]').click();
  await expect(page.getByRole('region', { name: '文档阅读器' }).locator('.source-text')).toContainText('检索候选碎片 20');
});

test('历史消息仅有 citations 时仍常驻展示四个参考段落', async ({ page }) => {
  await fixture(page, true);
  await page.getByText('结构引用历史', { exact: true }).click();
  const references = page.locator('.retrieved-sources');
  await expect(references.locator('summary')).toHaveText('参考段落（4）');
  await references.locator('summary').click();
  await expect(references.getByRole('button')).toHaveCount(4);
  await references.getByRole('button').last().click();
  await expect(page.getByRole('region', { name: '文档阅读器' })).toContainText('检索候选碎片 101');
});

test('写作尚无已确认 citations 时隐藏候选列表并保留生成状态', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/stream-chat', route => route.fulfill({ contentType: 'text/event-stream', body:
    event('sources', candidates) + event('accepted', { taskId: 12, chatId: 7, requestId: 'structural' }) }));
  await page.route('**/api/tasks/12', route => route.fulfill({ json: { data: {
    id: 12, status: 'running', stage: 'generation', completed: 0, total: null,
  } } }));
  await ask(page);
  await expect(page.locator('.generation-status')).toBeVisible();
  await expect(page.locator('.generation-status')).toContainText('后台');
  await expect(page.locator('.retrieved-sources')).toHaveCount(0);
});

test('中断时保留已确认的完整引用快照而非同编号候选碎片', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/stream-chat', route => route.fulfill({ contentType: 'text/event-stream', body:
    event('sources', candidates) + event('citations', [citations[0]]) + event('message', '杭州实习 [3]') +
    event('error', { message: '流式连接中断' }) }));
  await ask(page);
  await expect(page.locator('.interrupted-label')).toBeVisible();
  const references = page.locator('.retrieved-sources');
  await expect(references.locator('summary')).toHaveText('参考段落（1）');
  await references.locator('summary').click();
  await references.getByRole('button', { name: '[3] 结构引用.pdf · 杭州实习', exact: true }).click();
  await expect(page.getByRole('region', { name: '文档阅读器' }).locator('.source-text')).toHaveText(citations[0].text);
});

test('sourceSegments 使用保存快照，避免旧单范围上下文混入相邻实习', async ({ page }) => {
  await fixture(page, true);
  const contextRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/citation-context')) contextRequests.push(request.url()); });
  await page.getByText('结构引用历史', { exact: true }).click();
  await page.locator('[data-citation="3"]').click();
  const reader = page.getByRole('region', { name: '文档阅读器' });
  await expect(reader.locator('.reader-loading')).toHaveCount(0);
  await expect(reader.locator('.source-text')).toHaveText('杭州实习完整第一段\n杭州实习完整第二段');
  expect(contextRequests).toEqual([]);
});
