import { jest } from '@jest/globals';
import { SummaryService } from '../src/modules/rag/summary.service';
import { ModelOutputError } from '../src/modules/llm/llm.types';
import { AgentLimitError } from '../src/modules/agent/agent-budget';
import { ConfigService } from '@nestjs/config';
import { MemoryStore } from '../src/persistence/memory.store';
import { TokenizerService } from '../src/modules/embeddings/tokenizer.service';
import { ModelSettingsService } from '../src/modules/model-settings/model-settings.service';
import { modelBinding, runWithModels } from '../src/modules/model-settings/model-runtime';
describe('agent summary caching',()=>{
 it('invalidates a same-name model at a different endpoint but reuses summaries after key rotation', async () => {
  const store = new MemoryStore(), config = new ConfigService({ STORAGE_DRIVER: 'memory', JWT_SECRET: 'cache-fixture-secret-32-characters', CHAT_TOKENIZER: 'test:unicode-v1' });
  const settings = new ModelSettingsService(store, config);
  const llm = { complete: async (prompt: string) => prompt.startsWith('核查摘要') ? '{"supported":true}' :
    (modelBinding(config, 'agent').baseUrl.includes('first') ? '第一服务原文要点[1]' : '第二服务原文要点[1]') };
  const service = new SummaryService(store, llm as any, new TokenizerService(config), config);
  const source: any = { number: 1, evidenceId: 'original-1', documentId: 1, indexRevisionId: 2, chunkId: 3, filename: 'a', text: '原文', location: null };
  const meta = { userId: 1, knowledgeBaseId: 2, question: '问题', revisions: [2] };
  const input = { provider: 'openai-compatible' as const, model: 'same-model', baseUrl: 'https://first.example/v1', apiKey: 'first-key' };
  await settings.save(1, 'agent', input);
  const run = async () => runWithModels(await settings.resolveRuntime(1), () => service.summarizeAgent([source], meta, { role: 'agent' }));
  expect((await run()).groups[0].summary).toBe('第一服务原文要点[1]');
  await settings.save(1, 'agent', { ...input, apiKey: 'rotated-key' });
  expect((await run()).groups[0].summary).toBe('第一服务原文要点[1]');
  expect(await store.list('summaryCaches')).toHaveLength(1);
  await settings.save(1, 'agent', { ...input, baseUrl: 'https://second.example/v1', apiKey: 'second-key' });
  expect((await run()).groups[0].summary).toBe('第二服务原文要点[1]');
  expect(await store.list('summaryCaches')).toHaveLength(2);
 });
 it.each([
  { error: new ModelOutputError('回答达到输出长度上限'), expected: ['第一组[1]', '第三组[1]'], failed: [2] },
  { error: new AgentLimitError(), expected: ['第一组[1]'], failed: [2, 3] },
 ])('keeps verified sections after $error', async ({ error, expected, failed }) => {
  const llm = { complete: jest.fn<any>()
    .mockResolvedValueOnce('第一组[1]').mockResolvedValueOnce('{"supported":true}')
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce('第三组[1]').mockResolvedValueOnce('{"supported":true}') };
  const service = new SummaryService(
    { list: async () => [], save: async () => {} } as any, llm as any,
    { count: async (t: string) => t.length, windows: async (t: string) => [{ text: t }] } as any,
    { get: () => undefined } as any,
  );
  const sources = [1, 2, 3].map((id) => ({
    evidenceId: String(id), documentId: id, indexRevisionId: 1, filename: 'a', text: '原文',
  }));
  const result = await service.summarizeAgent(sources as any, {
    userId: 1, knowledgeBaseId: 2, question: '总结全文', revisions: [1],
  });
  expect(result.groups.map((group) => group.summary)).toEqual(expected);
  expect(result.coverage).toMatchObject({ complete: false, failedSections: failed });
 });
 it('keeps stable evidence references when cached groups are reused',async()=>{
  const rows:any[]=[]; const store:any={list:async (_:any,q:any)=>rows.filter(r=>r.cacheKey===q.cacheKey),save:async (_:any,r:any)=>{rows.push(r);return r;}};
  const llm:any={complete:jest.fn<any>().mockResolvedValueOnce('要点[1]').mockResolvedValueOnce('{"supported":true}')};
  const summary=new SummaryService(store,llm,{count:async(t:string)=>t.length,windows:async(t:string)=>[{text:t}]} as any,{get:()=>undefined} as any);
  const source:any={number:1,evidenceId:'stable-1',documentId:1,indexRevisionId:2,chunkId:3,filename:'a',text:'原文',location:null};
  const options:any={signal:undefined,observer:{before:async()=>'',settle:async()=>{}}};
  const first=await summary.summarizeAgent([source],{userId:1,knowledgeBaseId:2,question:'问题',revisions:[2]},options);
  const second=await summary.summarizeAgent([{...source,number:7}],{userId:1,knowledgeBaseId:2,question:'问题',revisions:[2]},options);
  expect(first.groups[0].refs).toEqual({'1':'stable-1'});expect(second.groups[0].refs).toEqual({'1':'stable-1'});expect(llm.complete).toHaveBeenCalledTimes(2);
 });
});
