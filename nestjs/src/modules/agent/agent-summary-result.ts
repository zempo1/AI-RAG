import { AgentSnapshot } from './agent.types';
import { OriginalEvidence } from '../rag/retrieval.types';

/** Already verified sections can remain useful when the complete original will not fit one answer. */
export function verifiedSummaryResult(state: AgentSnapshot, outputBudget: number) {
  const groups = Object.values(state.summaries || {}).flat();
  const originals = new Map(state.evidence.map((e) => [e.evidenceId, e]));
  const selected = new Map<string, OriginalEvidence>();
  const paragraphs: string[] = [];
  for (const group of groups) {
    const ids = [...group.summary.matchAll(/\[(\d+)\]/g)].map((m) => group.refs[m[1]]);
    if (!ids.length || ids.some((id) => !originals.has(id))) continue;
    const next = new Map(selected);
    for (const id of ids)
      if (!next.has(id)) next.set(id, { ...originals.get(id)!, number: next.size + 1 });
    const paragraph = group.summary.replace(
      /\[(\d+)\]/g,
      (_m, n) => `[${next.get(group.refs[n])!.number}]`,
    );
    if (
      Buffer.byteLength([...paragraphs, paragraph].join('\n\n'), 'utf8') >
      Math.max(0, outputBudget - 400)
    )
      break;
    paragraphs.push(paragraph);
    for (const [id, source] of next) selected.set(id, source);
  }
  if (!paragraphs.length) return undefined;
  const coverage = Object.values(state.summaryCoverage || {});
  const allTargets = state.scope.documents.every((doc) =>
    [...selected.values()].some((e) => e.documentId === doc.documentId),
  );
  const complete =
    !state.directAnswer &&
    paragraphs.length === groups.length &&
    allTargets &&
    coverage.length > 0 &&
    coverage.every((c) => c.complete && c.fullDocument === true);
  const notice = complete
    ? ''
    : '说明：以下为通过原文核查的部分分组要点，未覆盖的内容不作推测。\n\n';
  return { answer: notice + paragraphs.join('\n\n'), sources: [...selected.values()], complete };
}
