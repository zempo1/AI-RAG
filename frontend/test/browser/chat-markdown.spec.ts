import { test, expect, type Page } from '@playwright/test';

const comparison = `良恶性肿瘤区别（据课件版）：

| 方面 | 良性 | 恶性 |
| --- | --- | --- |
| 分化 | 好 | 差 [1] |
| 生长方式 | 外生、膨胀 | 侵袭 [1] |
| 生长速度 | 慢 | 快 [1] |
| 复发转移 | 无 | 常见 [1] |
| 对机体影响 | 较少 | 大，致命 [1] |

---

以上按原文整理。`;

async function openAnswer(page: Page, content = comparison) {
  await page.addInitScript(() => localStorage.setItem('token', 'test-token'));
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path === '/api/knowledge-bases') data = [{ id: 1, name: '排版测试', rebuildTaskId: null }];
    if (path.endsWith('/documents')) data = { items: [], total: 0 };
    if (path === '/api/chats') data = [{ id: 41, title: '表格排版验证', knowledgeBaseId: 1 }];
    if (path === '/api/chats/41') data = { id: 41, knowledgeBaseId: 1, pendingTasks: [], messages: [{
      role: 'assistant', content, citations: [{ number: 1, documentId: 8, versionId: 9,
        knowledgeBaseId: 1, indexRevisionId: 10, chunkId: 11, filename: '原课件.pdf',
        text: '生长方式：外生、膨胀；侵袭。', score: 1,
        location: { page: 3, paragraph: 1, heading: null, start: 0, end: 18 } }],
    }] };
    if (path.endsWith('/preview')) data = { documentId: 8, versionId: 9, filename: '原课件.pdf',
      mimeType: 'application/pdf', originalAvailable: false, originalUrl: null };
    return route.fulfill({ json: { data } });
  });
  await page.goto('/');
  await page.getByText('表格排版验证', { exact: true }).click();
  await expect(page.locator('.message-row.assistant table')).toBeVisible();
}

test('对比回答有完整列宽、单元格留白和行分隔，表内引用仍可打开原文', async ({ page }) => {
  await page.setViewportSize({ width: 1242, height: 800 });
  await openAnswer(page);
  const table = page.locator('.message-row.assistant table');
  const styles = await table.evaluate(element => {
    const cell = element.querySelector('td')!, header = element.querySelector('th')!;
    const cellStyle = getComputedStyle(cell), headerStyle = getComputedStyle(header);
    return { padding: parseFloat(cellStyle.paddingLeft), rowRule: parseFloat(cellStyle.borderBottomWidth),
      align: headerStyle.textAlign, tableWidth: element.getBoundingClientRect().width,
      contentWidth: element.closest('.markdown-body')!.clientWidth };
  });
  expect(styles.padding).toBeGreaterThanOrEqual(12);
  expect(styles.rowRule).toBeGreaterThanOrEqual(1);
  expect(styles.align).toBe('left');
  expect(styles.tableWidth).toBeGreaterThan(styles.contentWidth * .95);
  await expect(table.locator('tbody tr')).toHaveCount(5);
  await expect(table.locator('[data-citation="1"]')).toHaveCount(5);
  await page.screenshot({ path: 'test-results/chat-comparison-table.png' });
  await table.locator('[data-citation="1"]').first().click();
  await expect(page.getByRole('region', { name: '文档阅读器' })).toContainText('生长方式：外生、膨胀；侵袭。');
});

test('宽表格只在表格区域横向滚动，正文保持原宽并可用键盘滚动', async ({ page }) => {
  const columns = Array.from({ length: 12 }, (_, i) => `字段 ${i + 1}`);
  const wide = `说明文字保持正常换行。\n\n| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n| ${columns.map((_, i) => `value-${i + 1}-abcdefghijk`).join(' | ')} |\n\n表格后的说明文字。`;
  await page.setViewportSize({ width: 1100, height: 800 });
  await openAnswer(page, wide);
  const scroll = page.locator('.markdown-table');
  await expect(scroll).toHaveCount(1);
  const bounds = await scroll.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth,
    markdownWidth: element.parentElement!.clientWidth, markdownScroll: element.parentElement!.scrollWidth }));
  expect(bounds.scroll).toBeGreaterThan(bounds.width);
  expect(bounds.markdownScroll).toBeLessThanOrEqual(bounds.markdownWidth + 2);
  await scroll.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
});

test('清理引用的sup包装，同时保留代码和普通HTML转义', async ({ page }) => {
  const wrapped = comparison.replace(/\[1\]/g, '<sup>[1]</sup>') +
    '\n\n代码示例：`<sup>[1]</sup>`\n\n普通标签：<sup>2</sup>\n\n<script>window.injected=true</script>';
  await openAnswer(page, wrapped);
  const table = page.locator('.message-row.assistant table');
  await expect(table).not.toContainText('<sup>');
  await expect(table.locator('[data-citation="1"]')).toHaveCount(5);
  await expect(page.locator('.markdown-body code')).toHaveText('<sup>[1]</sup>');
  await expect(page.locator('.markdown-body')).toContainText('<sup>2</sup>');
  await expect(page.locator('.markdown-body script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
  await table.locator('[data-citation="1"]').first().click();
  await expect(page.getByRole('region', { name: '文档阅读器' })).toBeVisible();
});
