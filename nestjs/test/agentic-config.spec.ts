import { validateConfig } from '../src/config/configuration';

const base = { STORAGE_DRIVER: 'memory', JWT_SECRET: 'x'.repeat(32), CHAT_MODEL: 'test-chat' };
describe('Agent configuration budgets', () => {
  it('inherits chat model and exposes the frozen budget defaults', () => {
    expect(validateConfig(base)).toMatchObject({ AGENT_MODEL: 'test-chat', AGENT_DECISIONS: 6, AGENT_TOOLS: 8, AGENT_TOOL_CONCURRENCY: 2, AGENT_ASSESSMENTS: 2, AGENT_MODEL_CALLS: 32, AGENT_TOKEN_BUDGET: 100000, AGENT_ACTIVE_MS: 600000, AGENT_SYNC_MS: 30000, AGENT_TOOL_TOKENS: 2000 });
  });
  it.each(['', '1.5', '-1', '1e3', true, null, 0, Infinity, 999999999])('rejects malformed or unreasonable decisions %p', value => {
    expect(() => validateConfig({ ...base, AGENT_DECISIONS: value })).toThrow('AGENT_DECISIONS');
  });
  it('reserves a final model call and enough tokens, and bounds concurrency and foreground time', () => {
    for (const values of [{ AGENT_MODEL_CALLS: 1 }, { AGENT_TOKEN_BUDGET: 1000 }, { AGENT_TOOLS: 1, AGENT_TOOL_CONCURRENCY: 2 }, { AGENT_ACTIVE_MS: 1000, AGENT_SYNC_MS: 2000 }])
      expect(() => validateConfig({ ...base, ...values })).toThrow(/AGENT_/);
    expect(validateConfig({ ...base, AGENT_MODEL_CALLS: '2' }).AGENT_MODEL_CALLS).toBe(2);
  });
});
