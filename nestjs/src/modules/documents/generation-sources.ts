import type { Row } from "../../persistence/store";
import type { TokenizerService } from "../embeddings/tokenizer.service";

/** Stratify by section, then by source position; exact duplicate chunks never consume a slot. */
export function selectGenerationSources(chunks: Row[], limit: number): Row[] {
  const seen = new Set<string>();
  const groups = new Map<string, Row[]>();
  for (const chunk of [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex || a.id - b.id)) {
    if (typeof chunk.text !== "string" || !chunk.text.trim()) continue;
    const normalized = chunk.text.replace(/\s+/g, " ").trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const section = String(
      chunk.location?.sectionTitle ||
        chunk.location?.heading ||
        chunk.retrievalMetadata?.sectionTitle ||
        chunk.location?.page ||
        "document",
    );
    const group = groups.get(section) || [];
    group.push(chunk);
    groups.set(section, group);
  }
  const values = [...groups.values()];
  const result: Row[] = [];
  let round = 0;
  // Interleave sections before taking more from the same section. Within each section use
  // alternating beginning/end and then the middle to avoid an introduction-only sample.
  while (result.length < limit) {
    let added = false;
    for (let g = 0; g < values.length && result.length < limit; g++) {
      const index =
        values.length > limit ? Math.round((g * (values.length - 1)) / Math.max(1, limit - 1)) : g;
      const group = values[index];
      if (!group) continue;
      const position =
        round % 2 === 0 ? Math.floor(round / 2) : group.length - 1 - Math.floor(round / 2);
      if (position < 0 || position >= group.length) continue;
      const chunk = group[position];
      if (!result.some((c) => c.id === chunk.id)) {
        result.push(chunk);
        added = true;
      }
    }
    if (!added) break;
    round++;
  }
  return result;
}
export function generationBatchSources(source: Row[], batch: number, batchCount: number) {
  const preferred = source.filter(
    (_, i) => batchCount === 1 || Math.floor((i * batchCount) / source.length) === batch,
  );
  if (!preferred.length && source.length) preferred.push(source[batch % source.length]);
  return preferred;
}

export async function packGenerationSources(
  preferred: Row[],
  prompt: (chunks: Row[]) => string,
  tokenizer: TokenizerService,
  budget: number,
) {
  const selected: Row[] = [];
  for (const chunk of preferred) {
    const candidate = [...selected, chunk];
    if ((await tokenizer.count(prompt(candidate))) <= budget) {
      selected.push(chunk);
    } else if (!selected.length) {
      const available = budget - (await tokenizer.count(prompt([{ ...chunk, text: "" }]))) - 64;
      if (available > 32) {
        const [window] = await tokenizer.windows(chunk.text, available, 0);
        if (window) {
          const truncated = { ...chunk, text: window.text };
          if ((await tokenizer.count(prompt([truncated]))) <= budget) selected.push(truncated);
        }
      }
    }
  }
  return selected;
}

/** Server-owned contiguous snippets: the model selects IDs instead of transcribing PDF text. */
export function generationEvidenceSources(chunks: Row[]) {
  return chunks.flatMap((chunk) => {
    const chars = Array.from(String(chunk.text || ""));
    const parts: { sourceId: string; chunkId: number; text: string; location: unknown }[] = [];
    let text = "",
      index = 0;
    const append = () => {
      if (text) {
        parts.push({
          sourceId: `s${chunk.id}_${index++}`,
          chunkId: chunk.id,
          text,
          location: chunk.location ?? null,
        });
        text = "";
      }
    };
    for (const char of chars) {
      if (text.length + char.length > 600) append();
      text += char;
    }
    append();
    return parts;
  });
}
