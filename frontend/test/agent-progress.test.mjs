import test from 'node:test';
import assert from 'node:assert/strict';
import { SseDecoder } from '../src/utils/sse.ts';
const agent = await import('../src/utils/agent-progress.ts').catch(() => ({}));
const stream = await import('../src/utils/chat-stream.ts').catch(() => ({}));
const step = (sequence, runId=8) => ({runId,sequence,kind:'tool_end',summary:'找到文字证据',tool:'read_document',sources:[{filename:'资料.pdf',page:3}]});
test('SSE dispatcher delivers agent_step without losing accepted/done completion', () => {
  assert.equal(typeof stream.dispatchChatEvent, 'function');
  const events = new SseDecoder().feed(new TextEncoder().encode('event: agent_step\ndata: '+JSON.stringify(step(1))+'\n\nevent: accepted\ndata: {"taskId":2,"retrievalRunId":8}\n\n'));
  const received=[];
  const callbacks={onAgentStep:v=>received.push(v),onAccepted:v=>received.push(v)};
  assert.equal(stream.dispatchChatEvent(events[0],callbacks),false);
  assert.equal(stream.dispatchChatEvent(events[1],callbacks),true);
  assert.deepEqual(received,[step(1),{taskId:2,retrievalRunId:8}]);
});
test('agent progress merges ordered steps idempotently by runId and sequence',()=>{
  assert.equal(typeof agent.mergeAgentSteps,'function');
  const result=agent.mergeAgentSteps([step(2)], [step(1),step(2),step(1,9)]);
  assert.deepEqual(result.map(s=>[s.runId,s.sequence]),[[8,1],[8,2],[9,1]]);
  assert.equal(result[1].sources[0].page,3);
});
test('legacy diagnostics has no agent and final diagnostics replaces live steps',()=>{
  assert.equal(typeof agent.getAgentProgress,'function');
  assert.equal(agent.getAgentProgress({tokens:{used:4}}),null);
  const final={plan:{intent:'search',complexity:'simple',subQuestions:['目标']},steps:[step(2)],budget:{tokens:4},status:'completed',stopReason:'sufficient'};
  assert.deepEqual(agent.getAgentProgress({agent:final}),final);
});
test('explicit cancellation posts only the task cancel endpoint and failure preserves caller task',async()=>{
  assert.equal(typeof agent.requestTaskCancellation,'function');
  const task={id:12,status:'running'}, calls=[];
  await assert.rejects(agent.requestTaskCancellation(task.id,async url=>{calls.push(url);throw new Error('offline');}),/offline/);
  assert.deepEqual(calls,['/api/tasks/12/cancel']);
  assert.deepEqual(task,{id:12,status:'running'});
});
