export interface MindMapNode {
  data: Record<string, any> & { text: string };
  children: MindMapNode[];
}
export interface MindMapDocument {
  schemaVersion: 2;
  root: MindMapNode;
  layout: string;
  theme?: any;
  view?: any;
  meta: Record<string, any>;
}
export function normalizeMindMap(input: unknown): MindMapDocument {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  if (!value || typeof value !== "object") throw new Error("思维导图数据损坏");
  const source = value as any;
  let count = 0;
  const node = (raw: any, depth = 0): MindMapNode => {
    if (!raw || typeof raw !== "object" || depth > 100 || ++count > 20000)
      throw new Error("思维导图结构无效或过大");
    const text = raw.data?.text ?? raw.topic ?? raw.text;
    if (typeof text !== "string" || (raw.children !== undefined && !Array.isArray(raw.children)))
      throw new Error("思维导图节点结构无效");
    return {
      data: { ...raw.data, text },
      children: (raw.children || []).map((child: any) => node(child, depth + 1)),
    };
  };
  return {
    schemaVersion: 2,
    root: node(source.root || source.nodeData || source),
    layout: ["logicalStructure", "mindMap", "organizationStructure", "timeline"].includes(
      source.layout,
    )
      ? source.layout
      : "logicalStructure",
    theme: source.theme,
    view: source.view,
    meta: source.meta || {},
  };
}
export function isOversizedMindMap(root: MindMapNode): boolean {
  let count = 0,
    oversized = false;
  const visit = (node: MindMapNode, depth: number) => {
    if (++count > 1000 || depth > 20) oversized = true;
    node.children.forEach((child) => visit(child, depth + 1));
  };
  visit(root, 1);
  return oversized;
}
