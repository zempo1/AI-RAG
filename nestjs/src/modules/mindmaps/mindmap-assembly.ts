import { ApiError } from "../../common/api-error";
import { normalizeMindMap, MindMapData } from "./mindmap-data";
import type { MindMapNotes } from "./mindmap-generator";

export interface CatalogTopic {
  id: string;
  topic: string;
  points: string[];
}
export interface Organization {
  title: string;
  groups: { title: string; ids: string[] }[];
}

/** Only exact duplicates within the same topic are merged; numbers and conditions stay verbatim. */
export function catalogNotes(notes: MindMapNotes[]): CatalogTopic[] {
  const topics = new Map<string, Set<string>>();
  for (const note of notes)
    for (const entry of note.topics) {
      const points = topics.get(entry.topic) || new Set<string>();
      entry.points.forEach((point) => points.add(point));
      topics.set(entry.topic, points);
    }
  return [...topics].map(([topic, points], index) => ({
    id: `t${index + 1}`,
    topic,
    points: [...points],
  }));
}

export function parseOrganization(value: unknown, catalog: CatalogTopic[]): Organization {
  let data: any = value;
  try {
    if (typeof data === "string")
      data = JSON.parse(data.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new ApiError(502, "导图分组 JSON 无效");
  }
  const title = (text: unknown) => typeof text === "string" && !!text.trim() && text.length <= 80;
  const known = new Set(catalog.map((t) => t.id));
  const seen = new Set<string>();
  if (
    !title(data?.title) ||
    !Array.isArray(data.groups) ||
    !data.groups.length ||
    data.groups.length > 12
  )
    throw new ApiError(502, "导图分组结构无效");
  const groups = data.groups.map((g: any) => {
    if (!title(g?.title) || !Array.isArray(g.ids) || !g.ids.length)
      throw new ApiError(502, "导图分组结构无效");
    for (const id of g.ids) {
      if (!known.has(id) || seen.has(id)) throw new ApiError(502, "导图分组引用无效");
      seen.add(id);
    }
    return { title: g.title, ids: [...g.ids] };
  });
  if (seen.size !== known.size) throw new ApiError(502, "导图分组遗漏主题");
  return { title: data.title, groups };
}

export function assembleMindMap(
  catalog: CatalogTopic[],
  organization?: Organization,
  title = "文档知识要点",
): MindMapData {
  if (!catalog.length) throw new ApiError(502, "没有可组装的知识点");
  // Reserve one fact per topic and group overhead within the 300-node generation limit.
  const chosen =
    catalog.length <= 140
      ? catalog
      : Array.from(
          { length: 140 },
          (_, i) => catalog[Math.floor((i * (catalog.length - 1)) / 139)],
        );
  const ids = new Set(chosen.map((t) => t.id));
  const groups = organization
    ? organization.groups
        .map((g) => ({ ...g, ids: g.ids.filter((id) => ids.has(id)) }))
        .filter((g) => g.ids.length)
    : Array.from({ length: Math.min(12, Math.ceil(chosen.length / 8)) }, (_, i) => ({
        title: `主题组 ${i + 1}`,
        ids: chosen
          .filter(
            (_, j) =>
              Math.floor((j * Math.min(12, Math.ceil(chosen.length / 8))) / chosen.length) === i,
          )
          .map((t) => t.id),
      }));
  const allocated = new Map(chosen.map((t) => [t.id, 0]));
  let budget = 300 - 1 - groups.length - chosen.length;
  for (let round = 0; budget > 0; round++) {
    let added = false;
    for (const t of chosen)
      if (budget && round < t.points.length) {
        allocated.set(t.id, round + 1);
        budget--;
        added = true;
      }
    if (!added) break;
  }
  const byId = new Map(chosen.map((t) => [t.id, t]));
  const map = normalizeMindMap(
    {
      text: organization?.title || title,
      children: groups.map((g) => ({
        text: g.title,
        children: g.ids.map((id) => {
          const t = byId.get(id)!;
          return {
            data: { text: t.topic, expand: false },
            children: t.points.slice(0, allocated.get(id)).map((text) => ({ text })),
          };
        }),
      })),
    },
    { nodes: 300, depth: 5 },
  );
  map.meta = {
    assembly: {
      organization: organization ? "model" : "source-order",
      totalTopics: catalog.length,
      retainedTopics: chosen.length,
      omittedTopics: catalog.length - chosen.length,
      omittedPoints:
        catalog.reduce((n, t) => n + t.points.length, 0) -
        [...allocated.values()].reduce((a, b) => a + b, 0),
    },
  };
  return map;
}
