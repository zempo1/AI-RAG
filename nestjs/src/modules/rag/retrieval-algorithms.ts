export interface Scored {
  id: number;
  score: number;
}
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const words: string[] = normalized.match(/[a-z0-9][a-z0-9_.:/-]*/g) || [];
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  for (const part of segmenter.segment(normalized))
    if (part.isWordLike && /\p{Script=Han}/u.test(part.segment)) words.push(part.segment);
  return words;
}
export function terms(text: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const word of tokenize(text)) result[word] = (result[word] || 0) + 1;
  return result;
}
export interface LexicalDocument {
  id: number;
  text: string;
  terms?: Record<string, number>;
}
/** Immutable per-revision inverted index. Statistics are computed over the
 * authorized subset at query time; postings from other scopes never count. */
export class LexicalIndex {
  readonly lengths = new Map<number, number>();
  readonly postings = new Map<string, Map<number, number>>();
  constructor(documents: LexicalDocument[]) {
    for (const document of documents) {
      const frequencies = document.terms || terms(document.text);
      this.lengths.set(
        document.id,
        Object.values(frequencies).reduce((a, b) => a + b, 0),
      );
      for (const [word, tf] of Object.entries(frequencies)) {
        const posting = this.postings.get(word) || new Map<number, number>();
        posting.set(document.id, tf);
        this.postings.set(word, posting);
      }
    }
  }
}
export function searchLexical(
  query: string,
  indexes: LexicalIndex[],
  authorized: Set<number>,
): Scored[] {
  const lengths = new Map<number, number>();
  for (const index of indexes)
    for (const [id, length] of index.lengths) if (authorized.has(id)) lengths.set(id, length);
  if (!lengths.size) return [];
  const average = [...lengths.values()].reduce((a, b) => a + b, 0) / lengths.size || 1;
  const scores = new Map<number, number>();
  for (const word of new Set(tokenize(query))) {
    const matches = new Map<number, number>();
    for (const index of indexes)
      for (const [id, tf] of index.postings.get(word) || [])
        if (authorized.has(id)) matches.set(id, tf);
    const idf = Math.log(1 + (lengths.size - matches.size + 0.5) / (matches.size + 0.5));
    for (const [id, tf] of matches)
      scores.set(
        id,
        (scores.get(id) || 0) +
          (idf * (tf * 2.2)) / (tf + 1.2 * (0.25 + (0.75 * lengths.get(id)!) / average)),
      );
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.id - b.id);
}
export function bm25(query: string, documents: LexicalDocument[]): Scored[] {
  if (!documents.length) return [];
  const corpus = documents.map((d) => ({ ...d, terms: d.terms || terms(d.text) }));
  const lengths = corpus.map((d) => Object.values(d.terms).reduce((a, b) => a + b, 0));
  const average = lengths.reduce((a, b) => a + b, 0) / corpus.length || 1;
  const words = [...new Set(tokenize(query))];
  const frequencies = new Map(words.map((w) => [w, corpus.filter((d) => d.terms[w]).length]));
  return corpus
    .map((d, i) => ({
      id: d.id,
      score: words.reduce((sum, w) => {
        const tf = d.terms[w] || 0;
        if (!tf) return sum;
        const idf = Math.log(
          1 + (corpus.length - frequencies.get(w)! + 0.5) / (frequencies.get(w)! + 0.5),
        );
        return sum + (idf * (tf * 2.2)) / (tf + 1.2 * (0.25 + (0.75 * lengths[i]) / average));
      }, 0),
    }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score || a.id - b.id);
}
export function fuse(...rankings: Scored[][]): Scored[] {
  const scores = new Map<number, number>();
  for (const ranking of rankings)
    ranking.forEach((item, index) =>
      scores.set(item.id, (scores.get(item.id) || 0) + 1 / (60 + index + 1)),
    );
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id - b.id);
}
