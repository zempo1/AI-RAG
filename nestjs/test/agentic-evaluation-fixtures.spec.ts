import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function json(path: string, fallback: any = []) {
  try { return JSON.parse(await readFile(fileURLToPath(new URL('../' + path, import.meta.url)), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return fallback; throw error; }
}

it('adds 40 disjoint auditable Agent cases with 20 tune and 20 acceptance cases', async () => {
  const cases = await json('../docs/evaluation/agentic/cases.json');
  const baseline = await json('../docs/evaluation/accuracy/cases.json');
  expect(cases).toHaveLength(40);
  expect(cases.filter((c: any) => c.split === 'tune')).toHaveLength(20);
  expect(cases.filter((c: any) => c.split === 'acceptance')).toHaveLength(20);
  expect(new Set([...baseline, ...cases].map((c: any) => c.id)).size).toBe(100);
  expect(new Set(cases.map((c: any) => c.type))).toEqual(new Set([
    'exact', 'multi_hop', 'compare', 'overview', 'insufficient', 'clarification',
  ]));
});

it('maps every authored evidence quote to fixture source text and requires independent human review', async () => {
  const cases = await json('../docs/evaluation/agentic/cases.json');
  const documents = await json('../docs/evaluation/accuracy/documents.json');
  const byId = new Map(documents.map((d: any) => [d.id, d]));
  expect(cases.length).toBeGreaterThan(0);
  for (const item of cases) {
    expect(item.annotationStatus).toBe('authored_requires_human_review');
    for (const id of item.documentIds) expect(byId.has(id)).toBe(true);
    for (const evidence of item.evidence) {
      const doc: any = byId.get(evidence.document);
      expect(doc).toBeDefined();
      expect(doc.text).toContain(evidence.text);
    }
    if (item.type === 'compare') expect(item.documentIds.length).toBeGreaterThanOrEqual(2);
    if (item.type === 'insufficient') expect(item.expectedAbstention).toBe(true);
    if (item.type === 'clarification') expect(item.expectedClarification).toBe(true);
  }
});
