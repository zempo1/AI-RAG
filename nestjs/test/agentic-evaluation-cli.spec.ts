import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const script = resolve('scripts/evaluate-agentic.cjs');
const { mockModel } = createRequire(resolve('test/agentic-evaluation-cli.spec.ts'))(script);
describe('Agent evaluation CLI safety', () => {
  it('defaults to mock and requests an isolated build without accessing providers', () => {
    try {
      execFileSync(process.execPath, [script, '--build-dir', '.data/does-not-exist'], { encoding: 'utf8', env: { PATH: process.env.PATH, CHAT_API_KEY: 'do-not-use', EMBEDDING_API_KEY: 'do-not-use' } });
      throw new Error('expected missing-build failure');
    } catch (error: any) {
      expect(String(error.stderr)).toMatch(/tsc.*agentic-build/);
      expect(String(error.stderr)).not.toMatch(/Cannot find module|fetch failed/);
    }
  });
  it('rejects ambiguous mode and invalid sample limits before running', () => {
    for (const args of [['--mock', '--live'], ['--limit', '0'], ['--limit', '1.5'], ['--unknown']]) {
      expect(() => execFileSync(process.execPath, [script, ...args], { stdio: 'pipe' })).toThrow();
    }
  });
  it('merges the original 60 with 40 independent cases, keeping 50 per split', () => {
    const load = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../docs/evaluation/${name}/cases.json`, import.meta.url)), 'utf8'));
    const original = load('accuracy'), added = load('agentic'), all = [...original, ...added];
    expect(original).toHaveLength(60); expect(added).toHaveLength(40);
    expect(new Set(all.map(c => c.id)).size).toBe(100);
    expect(all.filter(c => c.split === 'tune')).toHaveLength(50);
    expect(all.filter(c => c.split === 'acceptance')).toHaveLength(50);
  });
  it('charges simulated tool requests through the real observer protocol and generates only from source text', async () => {
    const events: string[] = [];
    const observer = { before: async () => { events.push('before'); return 'reservation'; }, settle: async (_id: string, outcome: any) => { events.push(outcome.status); expect(outcome.usage).toBeUndefined(); } };
    const metrics = { calls: { chat: 0 }, estimatedTokens: 0 };
    const model = mockModel(metrics);
    const result = await model.invokeTools([{ role: 'user', content: JSON.stringify({ question: 'TS-999 表示什么？', documents: [], plan: { intent: 'search' } }) }], [], { observer });
    expect(result.toolCalls[0].name).toBe('keyword_search');
    expect(result.toolCalls[0].args.query).toBe('TS-999');
    const answer = await model.complete('问题：任意问题\n<原文>\n[1] 文件：test.md\n仅来自临时原文的唯一事实。\n</原文>', undefined, [], undefined, { observer });
    expect(answer).toContain('仅来自临时原文的唯一事实');
    expect(answer).toContain('[1]');
    expect(events).toEqual(['before', 'success', 'before', 'success']);
    expect(metrics.calls.chat).toBe(2);
  });
});
