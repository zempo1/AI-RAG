import type { ModelExecutionOptions, ToolMessage } from '../../src/modules/llm/llm.types';

/** Deterministic native tool model. Keeps the real Agent graph, retrieval and final-generation failure hooks. */
export function agentLlmFixture(legacy: { complete: (...args: any[]) => Promise<string>; stream: (...args: any[]) => AsyncIterable<string> }) {
  const request = (kind: 'complete' | 'stream' | 'tools', input: unknown, options: ModelExecutionOptions) =>
    ({ kind, input, model: 'offline-fixture', maxOutputTokens: options.maxOutputTokens || 1024 });
  async function observed<T>(kind: 'complete' | 'tools', input: unknown, options: ModelExecutionOptions, operation: () => Promise<T>): Promise<T> {
    options.signal?.throwIfAborted();
    const reservation = await options.observer?.before(request(kind, input, options));
    let outcome: any;
    let result: T;
    try { result = await operation(); options.signal?.throwIfAborted(); outcome = { status: 'success', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } }; }
    catch (error) { outcome = { status: options.signal?.aborted ? 'cancelled' : 'error', error }; if (reservation !== undefined) await options.observer!.settle(reservation, outcome); throw error; }
    if (reservation !== undefined) await options.observer!.settle(reservation, outcome);
    return result!;
  }
  return {
    complete: async (prompt: string, key?: string, images: any[] = [], signal?: AbortSignal, execution: ModelExecutionOptions = {}) =>
      observed('complete', prompt, { ...execution, signal: signal || execution.signal }, async () => {
        if (prompt.startsWith('分析用户问题')) {
          const question = prompt.split('问题：')[1].split('\n文件：')[0];
          return JSON.stringify({ intent: /总结|概览|全文/.test(question) ? 'overview' : 'search', complexity: 'simple', subQuestions: [question], ambiguous: false });
        }
        if (prompt.startsWith('检查原文是否支持')) {
          const questions = JSON.parse(prompt.split('\n子问题：')[1].split('\n原文：')[0]);
          const evidence = JSON.parse(prompt.split('\n原文：')[1]);
          return JSON.stringify({ supported: evidence.length > 0, missing: [], conflicting: [],
            subQuestions: questions.map((question: string) => ({ question, status: 'supported', evidenceIds: evidence.map((e: any) => e.id) })) });
        }
        if (prompt.startsWith('核查摘要')) return '{"supported":true}';
        return legacy.complete(prompt, key, images, signal, execution);
      }),
    invokeTools: async (messages: ToolMessage[], _tools: any[], options: any = {}) => observed('tools', messages, options, async () => {
      const input = JSON.parse(messages.find(m => m.role === 'user')!.content);
      const completed = messages.filter(m => m.role === 'tool');
      const call = (name: string, args: any) => ({ content: '', toolCalls: [{ id: `fixture-${completed.length}`, name, args }] });
      if (!completed.length) return call('list_documents', {});
      if (completed.length === 1) {
        const documents = JSON.parse(completed[0].content).documents;
        if (input.plan.intent === 'overview' && documents.length) return call('summarize_document', { documentId: documents[0].documentId });
        return call('knowledge_search', { query: input.question });
      }
      return { content: '证据已准备，申请作答', toolCalls: [] };
    }),
    stream: async function* (prompt: string, key?: string, signal?: AbortSignal, images: any[] = [], execution: ModelExecutionOptions = {}) {
      const options = { ...execution, signal: signal || execution.signal };
      options.signal?.throwIfAborted();
      const reservation = await options.observer?.before(request('stream', prompt, options));
      let completed = false, error: unknown;
      try { for await (const text of legacy.stream(prompt, key, signal, images, execution)) yield text; completed = true; }
      catch (caught) { error = caught; throw caught; }
      finally { if (reservation !== undefined) await options.observer!.settle(reservation, { status: completed ? 'success' : options.signal?.aborted ? 'cancelled' : 'error', error, ...(completed ? { usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } } : {}) }); }
    },
  };
}
