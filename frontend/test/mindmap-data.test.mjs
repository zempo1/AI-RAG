import test from "node:test";
import assert from "node:assert/strict";
const subject = await import("../src/features/mindmap/mindmap-data.ts").catch(() => ({}));
test("旧格式保留子节点和折叠状态并转换为完整文档", () => {
  assert.equal(typeof subject.normalizeMindMap, "function");
  for (const tree of [
    { root: { data: { text: "主题" }, children: [{ data: { text: "分支", expand: false } }] } },
    { nodeData: { topic: "主题", children: [{ topic: "分支", data: { expand: false } }] } },
  ]) {
    const result = subject.normalizeMindMap(JSON.stringify(tree));
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.root.children[0].data.text, "分支");
    assert.equal(result.root.children[0].data.expand, false);
  }
});
test("损坏导图明确报错而不是变成空根节点", () => {
  assert.equal(typeof subject.normalizeMindMap, "function");
  for (const value of ["undefined", "{}", '{"root":{"data":{"text":4}}}'])
    assert.throws(() => subject.normalizeMindMap(value));
});
test("完整导图保留布局和服务器元数据，超限历史变为只读", () => {
  assert.equal(typeof subject.normalizeMindMap, "function");
  let root = { data: { text: "根" }, children: [] };
  let current = root;
  for (let i = 0; i < 22; i++) {
    const child = { data: { text: "子" }, children: [] };
    current.children.push(child);
    current = child;
  }
  const result = subject.normalizeMindMap({
    root,
    layout: "mindMap",
    meta: { coverage: { complete: true } },
  });
  assert.equal(result.layout, "mindMap");
  assert.equal(result.meta.coverage.complete, true);
  assert.equal(subject.isOversizedMindMap(result.root), true);
});
