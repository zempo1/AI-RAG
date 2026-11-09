import { jest } from '@jest/globals';
import { SummaryService } from '../src/modules/rag/summary.service';
import { ModelOutputError } from '../src/modules/llm/llm.types';
import { AgentLimitError } from '../src/modules/agent/agent-budget';
describe('agent summary caching',()=>{
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
