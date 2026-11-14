import { test, expect, type Page } from '@playwright/test';
const step = {runId:88,sequence:1,kind:'tool_end',summary:'读取原文证据',tool:'read_document',sources:[{filename:'资料.pdf',page:3}]};
const agent = {plan:{intent:'search',complexity:'simple',subQuestions:['核对目标']},steps:[step],budget:{tokensUsed:120},status:'running',stopReason:null};
async function fixture(page:Page) {
  await page.addInitScript(()=>localStorage.setItem('token','test-token'));
  await page.route(url=>url.pathname.startsWith('/api/'),route=>{
    const path=new URL(route.request().url()).pathname;
    let data:unknown=[];
    if(path==='/api/knowledge-bases') data=[{id:1,name:'测试知识库',rebuildTaskId:null}];
    if(path.endsWith('/documents')) data={items:[],total:0};
    return route.fulfill({json:{data}});
  });
  await page.goto('/');
  await expect(page.getByPlaceholder('发送消息...')).toBeEnabled();
}

test('execution steps start collapsed, support keyboard expansion and keep cited paragraphs after the answer', async ({ page }) => {
  await fixture(page);
  const source = { number: 1, documentId: 1, versionId: 1, filename: '资料.pdf', text: '用于核对的证据正文' };
  await page.route('**/api/stream-chat', route => route.fulfill({ contentType: 'text/event-stream', body:
    `event: agent_step\ndata: ${JSON.stringify(step)}\n\nevent: sources\ndata: ${JSON.stringify([source])}\n\nevent: done\ndata: ${JSON.stringify({ answer: '已经完成回答 [1]', citations: [source], chatId: 7, generationStatus: 'completed', retrievalRunId: 88, diagnostics: { agent: { ...agent, status: 'completed' } } })}\n\n` }));
  await page.getByPlaceholder('发送消息...').fill('核对文档');
  await page.getByPlaceholder('发送消息...').press('Enter');
  await expect(page.locator('.markdown-body')).toContainText('已经完成回答');
  const timeline = page.locator('.agent-progress').first();
  const summary = timeline.locator('summary');
  await expect(summary).toHaveText('执行步骤（1）');
  await expect(timeline.locator('.agent-timeline')).toBeHidden();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(timeline.locator('.agent-timeline')).toBeVisible();
  await expect(timeline.locator('.agent-timeline')).toContainText('资料.pdf');
  await page.keyboard.press('Enter');
  await expect(timeline.locator('.agent-timeline')).toBeHidden();
  const sources = page.locator('.retrieved-sources');
  await expect(sources.locator('summary')).toHaveText('参考段落（1）');
  await sources.locator('summary').click();
  await expect(sources.getByRole('button')).toContainText('用于核对的证据正文');
});
test('Agent SSE steps deduplicate, background polling updates and explicit stop survives failures',async({page})=>{
  await fixture(page);
  await page.route('**/api/stream-chat',route=>route.fulfill({contentType:'text/event-stream',body:
    `event: agent_step\ndata: ${JSON.stringify(step)}\n\nevent: agent_step\ndata: ${JSON.stringify(step)}\n\nevent: accepted\ndata: {"taskId":12,"chatId":7,"requestId":"a","retrievalRunId":88}\n\n`}));
  let canceled=false,cancelCalls=0;
  await page.route('**/api/tasks/12',route=>route.fulfill({json:{data:{id:12,kind:'qa',status:canceled?'canceled':'running',stage:'agent',agentProgress:agent}}}));
  await page.route('**/api/tasks/12/cancel',route=>{
    expect(route.request().method()).toBe('POST'); cancelCalls++;
    if(cancelCalls===1) return route.fulfill({status:503,json:{message:'offline'}});
    canceled=true;return route.fulfill({json:{data:{id:12,status:'canceled'}}});
  });
  await page.getByPlaceholder('发送消息...').fill('核对文档');
  await page.getByPlaceholder('发送消息...').press('Enter');
  await expect(page.locator('.agent-timeline li')).toHaveCount(1);
  await expect(page.locator('.agent-timeline')).toContainText('第 3 页');
  const stop=page.getByRole('button',{name:'停止后台任务',exact:true});
  await expect(page.locator('.input-box').getByRole('button',{name:'停止后台任务',exact:true})).toHaveText('');
  await stop.focus();await page.keyboard.press('Enter');
  await expect(page.locator('.message-row.assistant').getByRole('alert')).toContainText('停止失败，后台任务仍在运行，可重试。');
  await expect(page.locator('.toast-item')).toHaveCount(0);
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(page.getByText('后台任务已停止，已获取的来源仍可查看。')).toBeVisible();
  expect(cancelCalls).toBe(2);
  await expect(page.locator('.agent-timeline')).toContainText('资料.pdf');
  canceled=false;
  await page.getByPlaceholder('发送消息...').fill('继续核对');
  await page.getByPlaceholder('发送消息...').press('Enter');
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(page.getByText('后台任务已停止，已获取的来源仍可查看。')).toHaveCount(2);
  expect(cancelCalls).toBe(3);
});
test('the composer button switches from send to an icon-only stop during foreground generation', async ({ page }) => {
  await fixture(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/stream-chat', async (route) => {
    await pending;
    await route.abort();
  });
  const composer = page.locator('.input-box');
  try {
    await page.getByPlaceholder('发送消息...').fill('核对文档');
    await composer.getByRole('button', { name: '发送消息' }).click();
    const stop = composer.getByRole('button', { name: '停止生成', exact: true });
    await expect(stop).toHaveText('');
    await expect(stop.locator('svg rect')).toHaveCount(1);
    await stop.click();
    await expect(composer.getByRole('button', { name: '发送消息' })).toBeVisible();
    await expect(page.getByText('已停止生成，已获取的来源仍可查看。')).toBeVisible();
  } finally {
    release();
  }
});

test('final Agent diagnostics replaces live trace and drawer shows only public plan',async({page})=>{
  await fixture(page);
  const finalAgent={...agent,steps:[{...step,sequence:2,summary:'证据检查完成'}],status:'completed',stopReason:'sufficient'};
  await page.route('**/api/stream-chat',route=>route.fulfill({contentType:'text/event-stream',body:
    `event: agent_step\ndata: ${JSON.stringify(step)}\n\nevent: done\ndata: ${JSON.stringify({answer:'答案',citations:[],chatId:7,generationStatus:'completed',retrievalRunId:88,diagnostics:{agent:finalAgent}})}\n\n`}));
  await page.route('**/api/retrieval-runs/88',route=>route.fulfill({json:{data:{payload:{agent:{...finalAgent,messages:['SECRET_INTERNAL_PROMPT']}}}}}));
  await page.getByPlaceholder('发送消息...').fill('问题');await page.getByPlaceholder('发送消息...').press('Enter');
  await expect(page.locator('.agent-timeline')).toContainText('证据检查完成');
  await expect(page.locator('.agent-timeline')).not.toContainText('读取原文证据');
  await page.getByRole('button',{name:'查看检索过程',exact:true}).click();
  await expect(page.locator('.retrieval-debug')).toContainText('核对目标');
  await expect(page.locator('.retrieval-debug')).toContainText('sufficient');
  await expect(page.locator('.retrieval-debug')).not.toContainText('SECRET_INTERNAL_PROMPT');
});

test('background polling merges progress then loads final persisted diagnostics',async({page})=>{
  await fixture(page);
  let polls=0;
  const finalAgent={...agent,steps:[{...step,sequence:3,summary:'最终核查完成'}],status:'completed',stopReason:'sufficient'};
  await page.route('**/api/stream-chat',route=>route.fulfill({contentType:'text/event-stream',body:
    `event: agent_step\ndata: ${JSON.stringify(step)}\n\nevent: accepted\ndata: {"taskId":12,"chatId":7,"requestId":"a","retrievalRunId":88}\n\n`}));
  await page.route('**/api/tasks/12',route=>{
    polls++;
    return route.fulfill({json:{data:{id:12,kind:'qa',status:polls===1?'running':'completed',stage:'agent',
      agentProgress:{...agent,steps:[{...step,sequence:2,summary:'补查第三页'}]},qaResult:{retrievalRunId:88}}}});
  });
  await page.route('**/api/chats/7',route=>route.fulfill({json:{data:{knowledgeBaseId:1,messages:[
    {role:'user',content:'核对文档'},
    {role:'assistant',content:'后台保存的答案',retrievalRunId:88,diagnostics:{agent:finalAgent}},
  ],pendingTasks:[]}}}));
  await page.getByPlaceholder('发送消息...').fill('核对文档');
  await page.getByPlaceholder('发送消息...').press('Enter');
  await expect(page.locator('.agent-timeline li')).toHaveCount(2);
  await expect(page.locator('.generation-status')).toHaveAttribute('aria-live','polite');
  await expect(page.locator('.generation-status')).toContainText('补查第三页');
  await expect(page.locator('.agent-timeline')).toContainText('最终核查完成');
  await expect(page.locator('.agent-timeline li')).toHaveCount(1);
  await expect(page.getByText('后台保存的答案',{exact:true})).toBeVisible();
  await expect(page.getByPlaceholder('发送消息...')).toBeEnabled();
});

test('background progress stays beside its answer without duplicate activity or placeholder prose', async ({ page }, testInfo) => {
  await fixture(page);
  let offline = false;
  await page.route('**/api/stream-chat', route => route.fulfill({ contentType: 'text/event-stream', body:
    'event: accepted\ndata: {"taskId":12,"chatId":7,"requestId":"a","retrievalRunId":88}\n\n' }));
  await page.route('**/api/tasks/12', route => offline
    ? route.fulfill({ status: 503, json: { message: 'offline' } })
    : route.fulfill({ json: { data: { id: 12, kind: 'qa', status: 'running', stage: 'agent', agentProgress: agent } } }));
  await page.getByPlaceholder('发送消息...').fill('核对文档');
  await page.getByPlaceholder('发送消息...').press('Enter');
  const answer = page.locator('.message-row.assistant');
  const status = answer.locator('.generation-status');
  await expect(status).toContainText('读取原文证据');
  await expect(status).toContainText('后台');
  await expect(status).toContainText('可离开');
  await expect(page.locator('.qa-task-status')).toHaveCount(0);
  await expect(answer.locator('.markdown-body')).toBeEmpty();
  await expect(answer.locator('.agent-activity')).toHaveCount(0);
  await expect(answer.getByRole('status')).toHaveCount(1);
  await expect(answer.locator('.agent-timeline')).toBeHidden();
  const statusBox = await status.boundingBox();
  expect(statusBox!.height).toBeLessThan(70);
  await page.screenshot({ path: testInfo.outputPath('background-status-wide.png'), fullPage: true });
  await page.locator('.sidebar .collapse-trigger').click();
  await page.locator('.workbench .collapse-btn').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sidebar')).toHaveCSS('width', '72px');
  await expect(page.locator('.workbench')).toHaveCSS('width', '40px');
  await expect(status).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('background-status-narrow.png'), fullPage: true });
  offline = true;
  await expect(status).toContainText('正在重试');
  await expect(page.locator('.toast-item')).toHaveCount(0);
  await expect(answer.getByRole('status')).toHaveCount(1);
  offline = false;
  await expect(status).toContainText('读取原文证据');
  await expect(status).not.toContainText('正在重试');
});

test('reopening a conversation restores pending progress beside an empty answer', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/chats', route => route.fulfill({ json: { data: [{ id: 7, title: '继续后台问答' }] } }));
  await page.route('**/api/chats/7', route => route.fulfill({ json: { data: {
    knowledgeBaseId: 1, messages: [{ role: 'user', content: '核对文档' }],
    pendingTasks: [{ id: 12, kind: 'qa', status: 'running', stage: 'agent', agentProgress: agent }],
  } } }));
  await page.route('**/api/tasks/12', route => route.fulfill({ json: { data: {
    id: 12, kind: 'qa', status: 'running', stage: 'agent', agentProgress: agent,
  } } }));
  await page.reload();
  await page.getByText('继续后台问答', { exact: true }).click();
  const answer = page.locator('.message-row.assistant');
  await expect(answer.getByRole('status')).toHaveCount(1);
  await expect(answer.getByRole('status')).toContainText('读取原文证据');
  await expect(answer.locator('.markdown-body')).toBeEmpty();
  await expect(page.getByRole('button', { name: '停止后台任务', exact: true })).toBeEnabled();
});

for (const terminal of ['failed', 'unreadable']) {
  test(`background ${terminal} stops the indicator and keeps its error beside the answer`, async ({ page }) => {
    await fixture(page);
    let finish = false;
    await page.route('**/api/stream-chat', route => route.fulfill({ contentType: 'text/event-stream', body:
      'event: accepted\ndata: {"taskId":12,"chatId":7,"requestId":"a","retrievalRunId":88}\n\n' }));
    await page.route('**/api/tasks/12', route => finish && terminal === 'unreadable'
      ? route.fulfill({ status: 404, json: { message: 'not found' } })
      : route.fulfill({ json: { data: { id: 12, kind: 'qa', status: finish ? 'failed' : 'running', stage: 'agent', agentProgress: agent, error: finish ? '问答未完成，请重试。' : null } } }));
    await page.getByPlaceholder('发送消息...').fill('核对文档');
    await page.getByPlaceholder('发送消息...').press('Enter');
    const answer = page.locator('.message-row.assistant');
    await expect(answer.locator('.generation-status')).toBeVisible();
    finish = true;
    await expect(answer.getByRole('alert')).toContainText(terminal === 'failed' ? '问答未完成' : '重新打开会话');
    await expect(answer.locator('.generation-status')).toHaveCount(0);
    await expect(answer.locator('.markdown-body')).toBeEmpty();
    await expect(page.getByPlaceholder('发送消息...')).toBeEnabled();
    await expect(page.locator('.toast-item')).toHaveCount(0);
  });
}

test('leaving an accepted background task never sends cancellation',async({page})=>{
  await fixture(page);
  let cancelCalls=0;
  await page.route('**/api/stream-chat',route=>route.fulfill({contentType:'text/event-stream',body:
    'event: accepted\ndata: {"taskId":12,"chatId":7,"requestId":"a","retrievalRunId":88}\n\n'}));
  await page.route('**/api/tasks/12',route=>route.fulfill({json:{data:{id:12,kind:'qa',status:'running',stage:'agent',agentProgress:agent}}}));
  await page.route('**/api/tasks/12/cancel',route=>{cancelCalls++;return route.fulfill({json:{data:{}}});});
  await page.getByPlaceholder('发送消息...').fill('后台问题');
  await page.getByPlaceholder('发送消息...').press('Enter');
  await expect(page.getByRole('button',{name:'停止后台任务',exact:true})).toBeEnabled();
  await page.getByText('新对话',{exact:true}).click();
  await expect(page.getByText('有什么我可以帮您的吗？',{exact:true})).toBeVisible();
  await page.goto('about:blank');
  expect(cancelCalls).toBe(0);
});

test('legacy retrieval diagnostics remains readable without Agent fields',async({page})=>{
  await fixture(page);
  await page.route('**/api/stream-chat',route=>route.fulfill({contentType:'text/event-stream',body:
    `event: done\ndata: ${JSON.stringify({answer:'旧版回答',citations:[],chatId:7,generationStatus:'completed',retrievalRunId:89})}\n\n`}));
  await page.route('**/api/retrieval-runs/89',route=>route.fulfill({json:{data:{payload:{originalQuestion:'旧检索问题',tokens:{used:15},messages:['PRIVATE_INTERNAL_MESSAGE']}}}}));
  await page.getByPlaceholder('发送消息...').fill('旧检索问题');
  await page.getByPlaceholder('发送消息...').press('Enter');
  await page.getByRole('button',{name:'查看检索过程',exact:true}).click();
  await expect(page.locator('.retrieval-debug')).toContainText('旧检索问题');
  await expect(page.locator('.retrieval-debug')).toContainText('15');
  await expect(page.locator('.retrieval-debug')).not.toContainText('Agent 任务规划');
  await expect(page.locator('.retrieval-debug')).not.toContainText('PRIVATE_INTERNAL_MESSAGE');
});
