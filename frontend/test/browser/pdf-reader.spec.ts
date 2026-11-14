import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const require = createRequire(resolve('../nestjs/package.json'));
const PDFDocument = require('pdfkit');
// 一个确定的红色 PNG，验证 PDF 内嵌位图实际落在 canvas，而不是只渲染文字。
function redPng() {
  const chunk=(kind:string,data:Buffer)=>{
    const type=Buffer.from(kind), content=Buffer.concat([type,data]);
    let crc=0xffffffff;
    for(const byte of content){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([size,content,checksum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,220,30,40]))),chunk('IEND',Buffer.alloc(0))]);
}
async function pdfFixture(large = false) {
  const doc = new PDFDocument({ size: [400, 600], margin: 40, autoFirstPage: false, compress: false });
  if(large)doc.info.Subject='range-fixture-'.repeat(16000);
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>(resolve => { doc.on('data', (x: Buffer) => chunks.push(x)); doc.on('end', () => resolve(Buffer.concat(chunks))); });
  for (let i = 1; i <= 3; i++) {
    doc.addPage(); doc.fontSize(14).text(`PDF PAGE ${i} searchable content`, 40, 72);
    doc.text(`SECOND LINE ${i}`, 40, 110);
    doc.image(redPng(),40,160,{width:80,height:60});
  }
  doc.end(); return completed;
}
const source = (number = 1, page = 2, extra = {}) => ({
  number, documentId: 1, versionId: 11, knowledgeBaseId: 1, indexRevisionId: 21,
  chunkId: number, filename: '阅读测试.pdf', text: `PDF PAGE ${page} searchable content`, score: 1,
  location: { page, paragraph: 1, heading: null, start: 0, end: 29, anchorVersion: 1,
    anchors: [{ page, start: 0, end: 29, rects: [[.1,.12,.75,.15],[.1,.18,.5,.21]], kind: 'native' }] }, ...extra,
});
async function fixture(page: Page, options: { missing?: boolean; originalMissing?: boolean; delayed?: boolean; large?: boolean } = {}) {
  page.on('pageerror', error => console.error('PDF browser error:', error.message));
  const pdf = await pdfFixture(options.large);
  const state = { originals: 0, previews: 0, auth: '', range: '', ranges: 0, activated: 0 };
  await page.addInitScript(() => { localStorage.setItem('token', 'test-token'); localStorage.setItem('username','tester'); });
  const citations = [source(), source(2, 3), source(3, 1, { sourceOutdated: true }), source(4, 1, { sourceDeleted: true }),
    source(5, 2, { location: { page: 2, paragraph: null, heading: null, start: 0, end: 29 } }),
    source(6, 1, { filename: '说明.md', documentId: 2, versionId: 12, location: { page: null, paragraph: 1, heading: '说明', start: 0, end: 8 } })];
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const body = (data: unknown) => route.fulfill({ json: { data } });
    if (path === '/api/knowledge-bases') return body([{id:1,name:'测试知识库',description:'',rebuildTaskId:null},{id:2,name:'其他知识库',description:'',rebuildTaskId:null}]);
    if (path.endsWith('/categories') || path === '/api/tasks' || path === '/api/mindmaps' || path === '/api/analyses') return body([]);
    if (/\/knowledge-bases\/\d+\/documents$/.test(path)) return body({items:[{id:1,filename:'阅读测试.pdf',knowledgeBaseId:1,categoryId:null,status:'ready',activeIndexRevisionId:21,activeVersionId:11}],total:1});
    if (path === '/api/chats') return body([{id:7,title:'阅读历史',knowledgeBaseId:1}]);
    if (path === '/api/chats/7') return body({id:7,knowledgeBaseId:1,pendingTasks:[],messages:[
      {role:'assistant',content:'引用二页[1]，引用三页[2]，历史版本[3]，已删除[4]，旧位置[5]，Markdown[6]',citations,sources:citations},
    ]});
    if (/\/preview$/.test(path)) {
      state.previews++; if (options.delayed) await new Promise(r => setTimeout(r, 180));
      const markdown = path.includes('/2/');
      return body({documentId:markdown?2:1,versionId:markdown?12:11,filename:markdown?'说明.md':'阅读测试.pdf',mimeType:markdown?'text/markdown':'application/pdf',originalAvailable:!options.missing,
        originalUrl:options.missing?null:`/api/documents/${markdown?2:1}/versions/${markdown?12:11}/original`,...(markdown?{text:'# 说明\n\nMarkdown 原文'}:{})});
    }
    if (path.endsWith('/original')) {
      state.originals++; state.auth=route.request().headers().authorization; state.range=route.request().headers().range || '';
      if(options.originalMissing) return route.fulfill({status:404,json:{message:'原件不存在'}});
      if(state.range) {
        state.ranges++; const [,startString,endString]=state.range.match(/bytes=(\d+)-(\d*)/)!;
        const start=Number(startString),end=Math.min(pdf.length-1,Number(endString)||pdf.length-1);
        return route.fulfill({status:206,contentType:'application/pdf',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${pdf.length}`,'Content-Length':String(end-start+1)},body:pdf.subarray(start,end+1)});
      }
      return route.fulfill({contentType:'application/pdf',headers:{'Accept-Ranges':'bytes','Content-Length':String(pdf.length)},body:pdf});
    }
    if(path.endsWith('/activate')) { state.activated++; return body({}); }
    if(path.endsWith('/citation-context')) return body({text:'回答时保存的上下文'});
    return body([]);
  });
  await page.goto('/'); await expect(page.getByPlaceholder('发送消息...')).toBeEnabled();
  return state;
}
async function history(page: Page) { await page.getByText('阅读历史', {exact:true}).click(); }

test('文件名打开真实 PDF、连续 canvas 和可选择文字层，关闭恢复工作台且不激活来源', async ({page}) => {
  const state=await fixture(page);
  await page.getByRole('button',{name:'管理文档',exact:true}).click();
  await page.getByRole('button',{name:'预览 阅读测试.pdf',exact:true}).click();
  const reader=page.getByRole('region',{name:'文档阅读器'});
  await expect(reader).toBeVisible(); await expect(page.locator('.knowledge-drawer')).toBeHidden();
  await expect(reader.locator('.page canvas').first()).toBeVisible();
  await expect(reader.locator('.textLayer').first()).toContainText('PDF PAGE 1');
  const pixel=await reader.locator('.page canvas').first().evaluate((el:HTMLCanvasElement)=>Array.from(el.getContext('2d')!.getImageData(Math.floor(el.width*.2),Math.floor(el.height*.3),1,1).data));
  expect(pixel.slice(0,3)).toEqual([220,30,40]);
  await expect(reader.getByLabel('页码', {exact:true})).toHaveValue('1');
  await expect(page.locator('.workbench')).toBeHidden();
  expect(state.auth).toBe('Bearer test-token'); expect(state.activated).toBe(0);
  await reader.getByRole('button',{name:'关闭阅读器'}).click();
  await expect(page.locator('.workbench')).toBeVisible();
});

test('引用等待正确页并分别高亮，缩放旋转保持对齐，全文搜索生效', async ({page}) => {
  await fixture(page); await history(page); await page.locator('[data-citation="1"]').click();
  const reader=page.getByRole('region',{name:'文档阅读器'});
  await expect(reader.getByLabel('页码',{exact:true})).toHaveValue('2');
  await expect(reader.locator('.page[data-page-number="2"] .citation-highlight')).toHaveCount(2);
  await expect(reader.locator('.source-text')).toBeHidden();
  await reader.locator('.reader-evidence summary').click();
  await expect(reader.locator('.source-text')).toBeVisible();
  const rect=reader.locator('.page[data-page-number="2"] .citation-highlight').first();
  await expect(rect).toBeInViewport();
  const relative=()=>rect.evaluate(el=>{const p=el.parentElement!.getBoundingClientRect(),r=el.getBoundingClientRect();return {x:(r.x-p.x)/p.width,y:(r.y-p.y)/p.height,w:r.width/p.width,h:r.height/p.height};});
  await expect.poll(async()=> (await relative()).x).toBeCloseTo(.1,2);
  await page.screenshot({path:'test-results/pdf-reader-desktop.png'});
  await reader.getByRole('button',{name:'放大'}).click();
  await expect.poll(async()=> (await relative()).w).toBeCloseTo(.65,2);
  await reader.getByRole('button',{name:'顺时针旋转 90 度'}).click();
  await expect.poll(async()=> (await relative()).x).toBeCloseTo(.85,2);
  await expect.poll(async()=> (await relative()).y).toBeCloseTo(.1,2);
  await reader.getByLabel('搜索 PDF 文字').fill('searchable');
  await expect(reader.locator('.pdf-find-status')).toContainText('3');
  await expect(reader.locator('.textLayer .highlight').first()).toBeAttached();
  await page.screenshot({path:'test-results/pdf-citation-rotated.png'});
});

test('快速切换同 PDF 引用最后一次生效并复用加载，旧版允许读取且缺位置只跳页', async ({page}) => {
  const state=await fixture(page,{delayed:true}); await history(page);
  await page.locator('[data-citation="1"]').click(); await page.locator('[data-citation="2"]').click();
  const reader=page.getByRole('region',{name:'文档阅读器'});
  await expect(reader.getByLabel('页码',{exact:true})).toHaveValue('3');
  expect(state.originals).toBe(1);
  await page.locator('[data-citation="3"]').click(); await expect(reader).toContainText('历史版本');
  await expect(reader.getByLabel('页码',{exact:true})).toHaveValue('1'); expect(state.originals).toBe(1);
  await page.locator('[data-citation="5"]').click(); await expect(reader).toContainText('缺少精准位置');
  await expect(reader.getByLabel('页码',{exact:true})).toHaveValue('2'); await expect(reader.locator('.citation-highlight')).toHaveCount(0);
});

for(const kind of ['missing','originalMissing','deleted'] as const) {
 test(`${kind} 保留引用快照与降级提示`,async({page})=>{
  await fixture(page,{[kind]:true}); await history(page); await page.locator(`[data-citation="${kind==='deleted'?4:1}"]`).click();
  const reader=page.getByRole('region',{name:'文档阅读器'});
  await expect(reader).toContainText('PDF PAGE');
  await expect(reader).toContainText(kind==='deleted'?'来源已删除':'原件');
  await expect(reader.locator('.pdfViewer canvas')).toHaveCount(0);
 });
}

test('窄屏阅读全屏可返回，Markdown 保持文本且切换聊天清除阅读器',async({page})=>{
 await page.setViewportSize({width:900,height:750}); await fixture(page); await history(page);
 await page.locator('[data-citation="1"]').click();
 const reader=page.getByRole('region',{name:'文档阅读器'}); await expect(reader).toBeVisible();
 await expect.poll(async()=>Math.round((await reader.boundingBox())!.width)).toBe(900);
 await expect(reader.locator('.citation-highlight')).toHaveCount(2);
 await page.screenshot({path:'test-results/pdf-reader-narrow.png'});
 await reader.getByRole('button',{name:'关闭阅读器'}).click();
 await expect(page.locator('[data-citation="1"]')).toBeFocused();
 await page.locator('[data-citation="6"]').click(); await expect(reader).toContainText('Markdown 原文');
 await expect(reader.locator('.pdfViewer')).toHaveCount(0);
 await reader.getByRole('button',{name:'关闭阅读器'}).click(); await page.getByText('新对话',{exact:true}).click();
 await expect(reader).toHaveCount(0);
});

test('原件失败后连续重试只保留最后一次加载且恢复真实页面',async({page})=>{
 const state=await fixture(page,{originalMissing:true}); await history(page); await page.locator('[data-citation="1"]').click();
 const reader=page.getByRole('region',{name:'文档阅读器'});
 const retry=reader.getByRole('button',{name:'重试读取原件'}); await expect(retry).toBeVisible();
 const pdf=await pdfFixture(); let reloads=0;
 await page.route('**/api/documents/1/versions/11/original',async route=>{reloads++;await route.fulfill({contentType:'application/pdf',body:pdf});});
 await retry.evaluate((button:HTMLButtonElement)=>{button.click();button.click();button.click();});
 await expect(reader.locator('.page canvas').first()).toBeVisible();
 expect(reloads).toBe(1); expect(state.originals).toBe(1);
});

test('大原件通过带 Authorization 的真实 Range 请求读取，本地 worker 与字体资源可用',async({page})=>{
 const state=await fixture(page,{large:true}); await history(page); await page.locator('[data-citation="1"]').click();
 const reader=page.getByRole('region',{name:'文档阅读器'});
 await expect(reader.locator('.page[data-page-number="2"] canvas')).toBeVisible();
 await expect.poll(()=>state.ranges).toBeGreaterThan(0); expect(state.auth).toBe('Bearer test-token');
 for(const path of ['/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap','/pdfjs/standard_fonts/LiberationSans-Regular.ttf','/pdfjs/wasm/openjpeg.wasm']){
  const response=await page.request.get(path);expect(response.ok()).toBe(true);expect((await response.body()).length).toBeGreaterThan(100);
 }
});

test('PDF 原件 401 走统一登录失效流程并清除阅读器',async({page})=>{
 await fixture(page); await history(page);
 await page.route('**/api/documents/1/versions/11/original',route=>route.fulfill({status:401,json:{message:'expired'}}));
 await page.locator('[data-citation="1"]').click();
 await expect(page.locator('.landing-wrapper')).toBeVisible();
 await expect(page.getByRole('region',{name:'文档阅读器'})).toHaveCount(0);
 expect(await page.evaluate(()=>localStorage.getItem('token'))).toBeNull();
});

test('删除最后一个知识库立即撤下正在查看的原件',async({page})=>{
 await fixture(page); await history(page); await page.locator('[data-citation="1"]').click();
 const reader=page.getByRole('region',{name:'文档阅读器'});
 await expect(reader.locator('.page canvas').first()).toBeVisible();
 await page.route('**/api/knowledge-bases/1',route=>route.fulfill({json:{data:{taskId:99}}}));
 await page.route('**/api/knowledge-bases',route=>route.fulfill({json:{data:[]}}));
 await page.getByRole('button',{name:'管理文档',exact:true}).click();
 await page.getByRole('button',{name:'知识库操作',exact:true}).click();
 await page.getByRole('menuitem',{name:'删除知识库',exact:true}).click();
 await page.locator('.knowledge-confirm').getByRole('button',{name:'确认',exact:true}).click();
 await expect(reader).toHaveCount(0);
});

test('阅读器使用图标关闭、快照默认折叠，工具栏在窄屏不溢出', async ({page}) => {
  await page.setViewportSize({width:946,height:667});
  await fixture(page); await history(page); await page.locator('[data-citation="1"]').click();
  const reader=page.getByRole('region',{name:'文档阅读器'});
  await expect(reader.locator('.page canvas').first()).toBeVisible();
  await expect(reader.getByRole('button',{name:'关闭阅读器'})).not.toContainText('关闭');
  await expect(reader.locator('.reader-evidence')).not.toHaveAttribute('open');
  for(const width of [946,390]) {
    await page.setViewportSize({width,height:667});
    const metrics=await reader.locator('.pdf-toolbar').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
    expect(metrics.width).toBeGreaterThan(width-4);
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.width);
    await page.screenshot({path:`test-results/reader-polish-${width}.png`});
  }
});

test('大量对话独立滚动且知识库保持在可见区域', async ({page}) => {
  await fixture(page);
  await page.route('**/api/chats',route=>route.fulfill({json:{data:Array.from({length:45},(_,i)=>({id:i+1,title:`历史对话 ${i+1}`,knowledgeBaseId:1}))}}));
  await page.reload();
  const list=page.locator('.chat-list');
  await expect(list.locator('.chat-item')).toHaveCount(45);
  const metrics=await list.evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight,overflow:getComputedStyle(el).overflowY}));
  expect(metrics.height).toBeLessThanOrEqual(360);
  expect(metrics.scroll).toBeGreaterThan(metrics.height);
  expect(metrics.overflow).toBe('auto');
  await expect(page.getByRole('button',{name:'管理文档',exact:true})).toBeInViewport();
  await list.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await expect(list.locator('.chat-item').last()).toBeInViewport();
});
