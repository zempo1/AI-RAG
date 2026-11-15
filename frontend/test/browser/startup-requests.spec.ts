import { test, expect } from '@playwright/test';
test('首屏每个初始化请求只发送一次，点击历史再加载正文', async ({page}) => {
  const counts = new Map<string, number>();
  await page.addInitScript(() => localStorage.setItem('token', 'test-token'));
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url()), key = url.pathname + url.search;
    counts.set(key, (counts.get(key) || 0) + 1);
    let data: any = [];
    if (url.pathname === '/api/knowledge-bases') data = [{id:2,name:'测试知识库',rebuildTaskId:null}];
    if (url.pathname.endsWith('/documents')) data = {items:[],total:0};
    if (url.pathname === '/api/chats') data = [{id:1,title:'按需历史',knowledgeBaseId:2}];
    if (url.pathname === '/api/chats/1') data = {id:1,knowledgeBaseId:2,messages:[{role:'assistant',content:'完整历史正文'}],pendingTasks:[]};
    await route.fulfill({json:{data}});
  });
  await page.goto('/');
  await expect(page.getByText('按需历史',{exact:true})).toBeVisible();
  await page.waitForLoadState('networkidle');
  for (const key of ['/api/chats','/api/mindmaps','/api/knowledge-bases',
    '/api/knowledge-bases/2/documents?page=1&pageSize=100'])
    expect(counts.get(key), key).toBe(1);
  expect(counts.has('/api/tasks?knowledgeBaseId=2')).toBe(false);
  expect(counts.has('/api/knowledge-bases/2/categories')).toBe(false);
  expect(counts.has('/api/knowledge-bases/2/documents?page=1&pageSize=20')).toBe(false);
  expect(counts.has('/api/chats/1')).toBe(false);
  await page.getByText('按需历史',{exact:true}).click();
  await expect(page.locator('.markdown-body')).toContainText('完整历史正文');
  await page.getByRole('button',{name:'管理文档',exact:true}).click();
  await page.waitForLoadState('networkidle');
  expect(counts.get('/api/tasks?knowledgeBaseId=2')).toBe(1);
  expect(counts.get('/api/knowledge-bases/2/categories')).toBe(1);
  expect(counts.get('/api/knowledge-bases/2/documents?page=1&pageSize=20')).toBe(1);
});

test('知识库列表返回前打开历史仍加载文档和任务', async ({page}) => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const counts = new Map<string, number>();
  await page.addInitScript(() => localStorage.setItem('token', 'test-token'));
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url());
    counts.set(url.pathname, (counts.get(url.pathname) || 0) + 1);
    let data: any = [];
    if (url.pathname === '/api/knowledge-bases') { await ready; data = [{id:2,name:'慢知识库',rebuildTaskId:null}]; }
    if (url.pathname === '/api/chats') data = [{id:1,title:'先开历史',knowledgeBaseId:2}];
    if (url.pathname === '/api/chats/1') data = {id:1,knowledgeBaseId:2,messages:[{role:'assistant',content:'历史已打开'}],pendingTasks:[]};
    if (url.pathname.endsWith('/documents')) data = {items:[],total:0};
    await route.fulfill({json:{data}});
  });
  await page.goto('/', {waitUntil:'domcontentloaded'});
  await page.getByText('先开历史',{exact:true}).click();
  await expect(page.locator('.markdown-body')).toContainText('历史已打开');
  release();
  await page.waitForLoadState('networkidle');
  expect(counts.has('/api/tasks')).toBe(false);
  expect(counts.has('/api/knowledge-bases/2/categories')).toBe(false);
  expect(counts.get('/api/knowledge-bases/2/documents')).toBe(1);
  await page.getByRole('button',{name:'管理文档',exact:true}).click();
  await page.waitForLoadState('networkidle');
  expect(counts.get('/api/tasks')).toBe(1);
  expect(counts.get('/api/knowledge-bases/2/categories')).toBe(1);
  expect(counts.get('/api/knowledge-bases/2/documents')).toBe(2);
});

test('切换对话仅加载历史及必要来源，不加载隐藏的管理数据', async ({page}) => {
  const requests: string[] = [];
  await page.addInitScript(() => localStorage.setItem('token','test-token'));
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url()); requests.push(url.pathname + url.search);
    let data: any = [];
    if(url.pathname === '/api/knowledge-bases') data=[{id:1,name:'甲库'},{id:2,name:'乙库'}];
    if(url.pathname === '/api/chats') data=[{id:1,title:'同库会话',knowledgeBaseId:1},{id:2,title:'跨库会话',knowledgeBaseId:2}];
    if(/^\/api\/chats\/\d+$/.test(url.pathname)) { const id=Number(url.pathname.split('/').at(-1)); data={id,knowledgeBaseId:id,messages:[{role:'assistant',content:`会话${id}`}],pendingTasks:[]}; }
    if(url.pathname.endsWith('/documents')) data={items:[],total:0};
    await route.fulfill({json:{data}});
  });
  await page.goto('/'); await page.waitForLoadState('networkidle'); requests.length=0;
  await page.getByText('同库会话',{exact:true}).click();
  await expect(page.locator('.markdown-body')).toContainText('会话1');
  await page.waitForLoadState('networkidle');
  expect(requests).toEqual(['/api/chats/1']); requests.length=0;
  await page.getByText('跨库会话',{exact:true}).click();
  await expect(page.locator('.markdown-body')).toContainText('会话2');
  await expect.poll(()=>requests).toEqual(['/api/chats/2','/api/knowledge-bases/2/documents?page=1&pageSize=100']);
  await page.waitForLoadState('networkidle');
  expect(requests).toHaveLength(2);
});

test('来源下拉展开复用在途请求', async ({page}) => {
  let release!: () => void; const pending=new Promise<void>(resolve=>release=resolve);
  let sources=0;
  await page.addInitScript(()=>localStorage.setItem('token','test-token'));
  await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
    const url=new URL(route.request().url()); let data:any=[];
    if(url.pathname==='/api/knowledge-bases') data=[{id:1,name:'测试库'}];
    if(url.pathname.endsWith('/documents')) { sources++; await pending; data={items:[],total:0}; }
    await route.fulfill({json:{data}});
  });
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect.poll(()=>sources).toBe(1);
  await page.locator('.qa-controls > .el-select').first().click();
  release(); await page.waitForLoadState('networkidle');
  expect(sources).toBe(1);
});

test('文档搜索合并连续输入，筛选不重复读取分类', async ({page}) => {
  const names:string[]=[]; let categories=0;
  await page.addInitScript(()=>localStorage.setItem('token','test-token'));
  await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
    const url=new URL(route.request().url()); let data:any=[];
    if(url.pathname==='/api/knowledge-bases') data=[{id:1,name:'测试库'}];
    if(url.pathname.endsWith('/categories')) categories++;
    if(url.pathname.endsWith('/documents')) { if(url.searchParams.get('name')) names.push(url.searchParams.get('name')!); data={items:[],total:0}; }
    await route.fulfill({json:{data}});
  });
  await page.goto('/'); await page.getByRole('button',{name:'管理文档',exact:true}).click();
  await page.waitForLoadState('networkidle');
  await page.getByPlaceholder('搜索文件名').pressSequentially('resume',{delay:25});
  await expect.poll(()=>names.at(-1)).toBe('resume');
  expect(names).toEqual(['resume']); expect(categories).toBe(1);
});

test('快速切换历史会取消旧请求，同一在途会话不重复读取', async ({page}) => {
  let release!:()=>void; const pending=new Promise<void>(resolve=>release=resolve);
  let oldRequests=0, aborted=0;
  page.on('requestfailed',r=>{if(new URL(r.url()).pathname==='/api/chats/1') aborted++;});
  await page.addInitScript(()=>localStorage.setItem('token','test-token'));
  await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
    const path=new URL(route.request().url()).pathname; let data:any=[];
    if(path==='/api/knowledge-bases') data=[{id:1,name:'库'}];
    if(path.endsWith('/documents')) data={items:[],total:0};
    if(path==='/api/chats') data=[{id:1,title:'慢会话'},{id:2,title:'快会话'}];
    if(path==='/api/chats/1') {oldRequests++; await pending; data={id:1,knowledgeBaseId:1,messages:[{role:'assistant',content:'旧结果'}]};}
    if(path==='/api/chats/2') data={id:2,knowledgeBaseId:1,messages:[{role:'assistant',content:'最新结果'}]};
    await route.fulfill({json:{data}}).catch(()=>undefined);
  });
  await page.goto('/'); await page.getByText('慢会话',{exact:true}).click();
  await expect.poll(()=>oldRequests).toBe(1);
  await page.getByText('慢会话',{exact:true}).click();
  await page.getByText('快会话',{exact:true}).click();
  await expect(page.locator('.markdown-body')).toContainText('最新结果');
  const count=oldRequests; release();
  await expect.poll(()=>aborted).toBe(1);
  expect(count).toBe(1);
  await expect(page.locator('.markdown-body')).not.toContainText('旧结果');
});

test('删除分类时迟到的旧管理请求不能恢复分类缓存', async ({page}) => {
  let releaseOld!:()=>void, releaseKB!:()=>void;
  const oldGate=new Promise<void>(r=>releaseOld=r), kbGate=new Promise<void>(r=>releaseKB=r);
  let categoryCalls=0, deleted=false, kbWaiting=false;
  await page.addInitScript(()=>localStorage.setItem('token','test-token'));
  await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
    const url=new URL(route.request().url()); let data:any=[];
    if(url.pathname==='/api/knowledge-bases') { if(deleted) {kbWaiting=true; await kbGate;} data=[{id:1,name:'库'}]; }
    if(url.pathname.endsWith('/documents')) data={items:[],total:0};
    if(url.pathname==='/api/knowledge-bases/1/categories/11') {deleted=true; data={};}
    if(url.pathname.endsWith('/categories')) {
      categoryCalls++; const snapshot=deleted?[]:[{id:11,name:'旧分类',knowledgeBaseId:1}];
      if(categoryCalls===2) await oldGate;
      data=snapshot;
    }
    await route.fulfill({json:{data}});
  });
  await page.goto('/'); await page.getByRole('button',{name:'管理文档',exact:true}).click();
  await expect(page.getByRole('button',{name:'删除分类旧分类',exact:true})).toBeVisible();
  await page.locator('.el-drawer__close-btn:visible').click();
  await page.getByRole('button',{name:'管理文档',exact:true}).click();
  await expect.poll(()=>categoryCalls).toBe(2);
  await page.getByRole('button',{name:'删除分类旧分类',exact:true}).click();
  await page.locator('.knowledge-confirm').getByRole('button',{name:'确认',exact:true}).click();
  await expect.poll(()=>kbWaiting).toBe(true);
  const oldResponse=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/categories'));
  releaseOld(); await (await oldResponse).finished();
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
  releaseKB();
  await expect.poll(()=>categoryCalls).toBe(3);
  await expect(page.getByRole('button',{name:'删除分类旧分类',exact:true})).toHaveCount(0);
});
