import { jest } from '@jest/globals';
import { AgentService } from '../src/modules/agent/agent.service';
import { AgentBudget } from '../src/modules/agent/agent-budget';

describe('AgentService', () => {
  const scope = {userId:1,knowledgeBaseId:2,documents:[{documentId:3,filename:'a',indexRevisionId:4}]};
  const evidence = {evidenceId:'ev1',number:0,documentId:3,knowledgeBaseId:2,versionId:1,indexRevisionId:4,chunkId:1,filename:'a',text:'原文',location:null,score:1};
  it('uses keyword retrieval and retains original evidence through assessment', async () => {
    const retrieval: any = {createScope:jest.fn().mockResolvedValue(scope),verify:jest.fn(),open:jest.fn().mockResolvedValue({scope}),search:jest.fn().mockResolvedValue({evidence:[evidence],channels:{},degraded:[],candidates:[]}),pack:jest.fn().mockResolvedValue({sources:[{...evidence,number:1}],tokens:10,complete:true}),context:(s:any[])=>s.map(x=>`[${x.number}] ${x.text}`).join('\n')};
    const llm: any = {complete:jest.fn().mockResolvedValueOnce('{"intent":"search","complexity":"simple","subQuestions":["问题"],"ambiguous":false}').mockResolvedValueOnce('{"supported":true,"missing":[],"conflicting":[],"subQuestions":[{"question":"问题","status":"supported","evidenceIds":["ev1"]}]}'),invokeTools:jest.fn().mockResolvedValueOnce({content:'',toolCalls:[{id:'c1',name:'keyword_search',args:{query:'精确'}}]}).mockResolvedValueOnce({content:'可以回答',toolCalls:[]})};
    const service = new AgentService(retrieval,llm,{} as any,{get:()=>undefined} as any,{} as any);
    const result = await service.prepare('问题',1,2,{});
    expect(retrieval.search.mock.calls[0][2].strategy).toBe('keyword');
    expect(result.sources[0].text).toBe('原文');
    expect(result.diagnostics.agent.status).toBe('ready');
  });
  it('rejects extra fields before invoking a tool', async () => {
    const retrieval:any={createScope:async()=>scope,verify:async()=>{},open:async()=>({scope}),search:jest.fn(),pack:async()=>({sources:[],tokens:0}),context:()=>''};
    const llm:any={complete:async()=>'{"intent":"search","complexity":"simple","subQuestions":[],"ambiguous":false}',invokeTools:async()=>({content:'',toolCalls:[{id:'x',name:'keyword_search',args:{query:'a',outside:true}}]})};
    const service=new AgentService(retrieval,llm,{} as any,{get:()=>undefined} as any,{} as any);
    await expect(service.prepare('问题',1,2,{})).rejects.toThrow('非法工具参数');
    expect(retrieval.search).not.toHaveBeenCalled();
  });
  it('keeps incomplete search evidence available for a grounded answer', async () => {
    const retrieval:any={createScope:async()=>scope,verify:async()=>{},open:async()=>({scope}),search:async()=>({evidence:[evidence]}),pack:async()=>({sources:[{...evidence,number:1}],tokens:1}),context:()=>''};
    const llm:any={complete:jest.fn<any>().mockResolvedValueOnce('{"intent":"search","complexity":"simple","subQuestions":[],"ambiguous":false}').mockResolvedValueOnce('{"supported":false,"missing":["缺口"],"conflicting":[]}'),invokeTools:jest.fn<any>().mockResolvedValueOnce({content:'',toolCalls:[{id:'x',name:'keyword_search',args:{query:'a'}}]}).mockResolvedValueOnce({content:'回答',toolCalls:[]})};
    const service=new AgentService(retrieval,llm,{} as any,{get:()=>undefined} as any,{} as any);
    const result=await service.prepare('问题',1,2,{evaluation:'single-round'});
    expect(result.directAnswer).toBeUndefined();
    expect(result.diagnostics.agent.status).toBe('partial');
  });
  it('rejects unsupported subquestion evidence IDs despite a positive assessment', async () => {
    const retrieval:any={createScope:async()=>scope,verify:async()=>{},open:async()=>({scope}),search:async()=>({evidence:[evidence]}),pack:async()=>({sources:[{...evidence,number:1}],tokens:1}),context:()=>''};
    const llm:any={complete:jest.fn<any>().mockResolvedValueOnce('{"intent":"search","complexity":"simple","subQuestions":["问题"],"ambiguous":false}').mockResolvedValueOnce('{"supported":true,"subQuestions":[{"question":"问题","status":"supported","evidenceIds":["invalid"]}]}'),invokeTools:jest.fn<any>().mockResolvedValueOnce({content:'',toolCalls:[{id:'x',name:'keyword_search',args:{query:'a'}}]}).mockResolvedValueOnce({content:'答复',toolCalls:[]})};
    const service=new AgentService(retrieval,llm,{} as any,{get:()=>undefined} as any,{} as any);
    const result=await service.prepare('问题',1,2,{evaluation:'single-round'});
    expect(result.diagnostics.agent.stopReason).toBe('insufficient_evidence');
    expect(result.sources.map((source: any) => source.evidenceId)).toEqual(['ev1']);
    expect(result.prompt).not.toContain('invalid');
  });
  it('continues inside an oversized original chunk using the returned offset', async () => {
    const retrieval:any={verify:async()=>{},read:async()=>({evidence:[{...evidence,text:'a'.repeat(3000),location:{start:0,end:3000}}],complete:true}),original:(e:any)=>({...e,evidenceId:'ev-'+e.location.start})};
    const service:any=new AgentService(retrieval,{} as any,{} as any,{get:()=>undefined} as any,{} as any);
    const state:any={scope,evidence:[]};
    const first=JSON.parse((await service.tool({name:'read_document',args:{documentId:3}},state,{},{})).output);
    expect(first.nextOffset).toBe(1200);
    const next=JSON.parse((await service.tool({name:'read_document',args:{documentId:3,offset:first.nextOffset}},state,{},{})).output);
    expect(next.evidence[0].evidenceId).toBe('ev-1200');
    expect(next.nextOffset).toBe(2400);
  });
  it('resumes a journaled tool result without running it again', async () => {
    const retrieval:any={verify:jest.fn<any>(),open:jest.fn<any>(),search:jest.fn<any>(),pack:async()=>({sources:[{...evidence,number:1}],tokens:1,complete:true}),context:()=>''};
    const llm:any={invokeTools:async()=>({content:'已完成',toolCalls:[]}),complete:async()=>'{"supported":true,"subQuestions":[{"question":"问题","status":"supported","evidenceIds":["ev1"]}]}' };
    const call={id:'x',name:'keyword_search',args:{query:'a'}};
    const snapshot:any={engine:'agentic-v1',userId:1,knowledgeBaseId:2,question:'问题',runId:7,scope,plan:{intent:'search',complexity:'simple',subQuestions:['问题']},steps:[],budget:AgentBudget.initial(),phase:'tool',evidence:[evidence],messages:[],pending:[call],journal:{[JSON.stringify([call.name,call.args])]:'{"evidence":[]}'},noProgress:0,roundEvidenceCount:0,repairUsed:false,history:[]};
    const result=await new AgentService(retrieval,llm,{} as any,{get:()=>undefined} as any,{} as any).resume(snapshot,{background:true});
    expect(retrieval.search).not.toHaveBeenCalled();expect(result.requiresAsync).toBe(false);expect(result.agentSnapshot.budget.calls).toBe(0);
  });
});

