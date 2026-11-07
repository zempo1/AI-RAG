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
  await stop.focus();await page.keyboard.press('Enter');
  await expect(page.getByText('停止失败，后台任务仍在运行，可重试。')).toBeVisible();
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
  await expect(page.locator('.agent-activity')).toHaveAttribute('aria-live','polite');
  await expect(page.locator('.agent-activity')).toContainText('补查第三页');
  await expect(page.locator('.agent-timeline')).toContainText('最终核查完成');
  await expect(page.locator('.agent-timeline li')).toHaveCount(1);
  await expect(page.getByText('后台保存的答案',{exact:true})).toBeVisible();
  await expect(page.getByPlaceholder('发送消息...')).toBeEnabled();
});

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
