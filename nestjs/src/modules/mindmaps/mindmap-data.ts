import { ApiError } from "../../common/api-error";

export interface MindMapNode {
  data: Record<string, any> & { text: string };
  children: MindMapNode[];
}
export interface MindMapData {
  schemaVersion: 2;
  root: MindMapNode;
  layout: string;
  theme?: any;
  view?: any;
  meta?: Record<string, any>;
}
export const mindMapLayouts = ["logicalStructure", "mindMap", "organizationStructure", "timeline"];
export function normalizeMindMap(
  input: string | any,
  limits = { nodes: 1000, depth: 20 },
): MindMapData {
  let value: any;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new ApiError(400, "思维导图 JSON 无效");
  }
  if (!value || typeof value !== "object") throw new ApiError(400, "思维导图结构无效");
  let count = 0;
  const visit = (node: any, depth: number): MindMapNode => {
    if (++count > limits.nodes || depth > limits.depth)
      throw new ApiError(400, "思维导图节点数量或层级超限");
    const text = node?.data?.text ?? node?.topic ?? node?.text;
    if (
      typeof text !== "string" ||
      !text.trim() ||
      (node.children !== undefined && !Array.isArray(node.children))
    )
      throw new ApiError(400, "思维导图节点结构无效");
    return {
      data: { ...node.data, text },
      children: (node.children || []).map((child: any) => visit(child, depth + 1)),
    };
  };
  const result: MindMapData = {
    schemaVersion: 2,
    root: visit(value.root ?? value.nodeData ?? value, 1),
    layout: mindMapLayouts.includes(value.layout) ? value.layout : "logicalStructure",
  };
  for (const key of ["theme", "view", "meta"] as const)
    if (value[key] !== undefined) result[key] = value[key];
  return result;
}
export function parseModelMap(response: string): MindMapData {
  return normalizeMindMap(response.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""), {
    nodes: 300,
    depth: 5,
  });
}
