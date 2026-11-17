import {
  assembleMindMap,
  catalogNotes,
  parseOrganization,
} from "../src/modules/mindmaps/mindmap-assembly";

const source = [
  {
    topics: [
      { topic: "条件", points: ["小于2cm才适用", "大于2cm不适用", "小于2cm才适用"] },
      { topic: "末尾章节", points: ["末尾独有知识"] },
    ],
  },
];
it("reuses facts verbatim and validates every organization reference", () => {
  const catalog = catalogNotes(source);
  const organized = parseOrganization(
    { title: "主题", groups: [{ title: "知识", ids: ["t1", "t2"] }] },
    catalog,
  );
  const map = assembleMindMap(catalog, organized);
  expect(map.root.children[0].children[0].children.map((n) => n.data.text)).toEqual([
    "小于2cm才适用",
    "大于2cm不适用",
  ]);
  expect(map.root.children[0].children[1].children[0].data.text).toBe("末尾独有知识");
  expect(map.root.children[0].children[0].data.expand).toBe(false);
  for (const ids of [["t1"], ["t1", "t1", "t2"], ["t1", "t2", "t3"]])
    expect(() =>
      parseOrganization({ title: "主题", groups: [{ title: "知识", ids }] }, catalog),
    ).toThrow();
});
it("bounds large maps fairly and reports omitted details without losing cached facts", () => {
  const catalog = catalogNotes([
    {
      topics: Array.from({ length: 100 }, (_, i) => ({
        topic: `主题${i}`,
        points: Array.from({ length: 10 }, (_, j) => `参数${i}-${j}`),
      })),
    },
  ]);
  const map = assembleMindMap(catalog);
  let count = 0;
  const visit = (n: any) => {
    count++;
    n.children.forEach(visit);
  };
  visit(map.root);
  expect(count).toBeLessThanOrEqual(300);
  expect(map.meta?.assembly.omittedPoints).toBeGreaterThan(0);
  expect(catalog).toHaveLength(100);
  expect(catalog[99].points).toHaveLength(10);
  expect(map.meta?.assembly.organization).toBe("source-order");
});
