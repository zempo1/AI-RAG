import { test, expect, type Page } from '@playwright/test';

const names = { chat: '对话', agent: 'Agent', vision: '图片理解', queryPlan: '查询规划', embedding: '向量化', rerank: '重排' };
async function fixture(page: Page, legacy = false) {
  let settings = Object.entries(names).map(([role]) => ({ role, provider: role === 'rerank' ? 'dashscope' : 'openai-compatible',
    model: role === 'embedding' ? 'old-embedding' : 'old-model', baseUrl: 'https://old.example/v1',
    hasApiKey: true, source: 'system', ...(role === 'embedding' ? { dimensions: 1024, sendDimensions: true } : {}) }));
  const writes: { role: string; body: any }[] = [];
  let failSave = false;
  let leakedHeader = false;
  await page.addInitScript(({ legacy }) => {
    localStorage.setItem('token', 'test-token'); localStorage.setItem('username', '测试账号');
    if (legacy) localStorage.setItem('user_api_key', 'old-browser-secret');
  }, { legacy });
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (req.headers()['x-api-key']) leakedHeader = true;
    if (url.pathname === '/api/model-settings') return route.fulfill({ json: { code: 200, data: settings } });
    if (url.pathname.startsWith('/api/model-settings/')) {
      const role = url.pathname.split('/').at(-1)!;
      if (req.method() === 'DELETE') {
        settings = settings.map(s => s.role === role ? { ...s, source: 'system', model: 'old-model', baseUrl: 'https://old.example/v1' } : s);
        return route.fulfill({ json: { data: settings.find(s => s.role === role) } });
      }
      writes.push({ role, body: req.postDataJSON() });
      if (failSave) return route.fulfill({ status: 400, json: { message: 'API 地址配置有误' } });
      settings = settings.map(s => s.role === role ? { ...s, ...req.postDataJSON(), apiKey: undefined, source: 'custom', hasApiKey: true } : s);
      return route.fulfill({ json: { data: settings.find(s => s.role === role) } });
    }
    if (url.pathname === '/api/knowledge-bases') return route.fulfill({ json: { data: [{ id: 1, name: '默认知识库', isDefault: 1 }] } });
    if (url.pathname.includes('/documents')) return route.fulfill({ json: { data: { items: [], total: 0 } } });
    return route.fulfill({ json: { data: [] } });
  });
  await page.goto('/');
  return { writes, setFail: (value: boolean) => { failSave = value; }, hasLeakedHeader: () => leakedHeader };
}

test('saves SiliconFlow BGE-M3 per account and reloads without showing the stored key', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模型设置', exact: true });
  await dialog.getByRole('tab', { name: '向量化', exact: true }).click();
  await dialog.getByLabel('接口协议', { exact: true }).press('ArrowDown');
  await page.getByRole('option', { name: '硅基流动', exact: true }).click();
  await dialog.getByLabel('模型名称', { exact: true }).fill('BAAI/bge-m3');
  await expect(dialog.getByLabel('API 地址', { exact: true })).toHaveValue('https://api.siliconflow.cn/v1');
  await dialog.getByLabel('API Key', { exact: true }).fill('new-silicon-key');
  await expect(dialog.getByLabel('发送 dimensions', { exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: '保存当前配置', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({ role: 'embedding', body: { model: 'BAAI/bge-m3', provider: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'new-silicon-key', dimensions: 1024, sendDimensions: false } });
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(dialog).toContainText('需手动重建索引');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await dialog.getByRole('tab', { name: '向量化', exact: true }).click();
  await expect(dialog.getByLabel('模型名称', { exact: true })).toHaveValue('BAAI/bge-m3');
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('');
  await page.screenshot({ path: 'test-results/model-settings-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('button', { name: '保存当前配置', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/model-settings-mobile.png' });
});

test('requires a key for a new endpoint, preserves drafts on failure and restores the default', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模型设置', exact: true });
  await dialog.getByLabel('API 地址', { exact: true }).fill('https://new.example/v1');
  await dialog.getByRole('button', { name: '保存当前配置', exact: true }).click();
  await expect(dialog).toContainText('修改 API 地址时请填写对应的 Key');
  expect(state.writes).toHaveLength(0);
  await dialog.getByLabel('API Key', { exact: true }).fill('replacement-key');
  state.setFail(true);
  await dialog.getByRole('button', { name: '保存当前配置', exact: true }).click();
  await expect(dialog).toContainText('API 地址配置有误');
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('replacement-key');
  state.setFail(false);
  await dialog.getByRole('button', { name: '恢复服务端默认', exact: true }).click();
  await expect(dialog.getByLabel('API 地址', { exact: true })).toHaveValue('https://old.example/v1');
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('');
});

test('imports a legacy key only on explicit action and stops injecting it into all requests', async ({ page }) => {
  const state = await fixture(page, true);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模型设置', exact: true });
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => localStorage.getItem('user_api_key'))).toBe('old-browser-secret');
  await dialog.getByRole('button', { name: '导入旧浏览器 Key', exact: true }).click();
  await dialog.getByRole('button', { name: '保存当前配置', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({ role: 'chat', body: { apiKey: 'old-browser-secret' } });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('user_api_key'))).toBeNull();
  expect(state.hasLeakedHeader()).toBe(false);
});
