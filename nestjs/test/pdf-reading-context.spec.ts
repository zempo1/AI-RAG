import { RetrievalService } from '../src/modules/rag/retrieval.service';

const retrieval = new RetrievalService({} as any, {} as any, {} as any, {} as any);
function source(number: number, text: string, start: number, parts: { text: string; y: number }[]) {
  let offset = start;
  const anchors = parts.map(part => {
    const at = start + text.indexOf(part.text, offset - start);
    offset = at + part.text.length;
    return { page: 1, start: at, end: offset, kind: 'native', rects: [[0.1, part.y, 0.8, part.y + 0.02]] };
  });
  return { number, documentId: 1, versionId: 1, indexRevisionId: 1, filename: '简历.pdf', text,
    location: { page: 1, start, end: start + text.length, anchorVersion: 1, anchors } };
}
it('uses native page geometry to keep each employer before its own responsibilities', () => {
  const sources: any[] = [
    source(1, '姓名小甲\n骨架屏缩短40%', 0, [{ text: '姓名小甲', y: 0.02 }, { text: '骨架屏缩短40%', y: 0.7 }]),
    source(2, '公司甲\n微前端开发', 30, [{ text: '公司甲', y: 0.2 }, { text: '微前端开发', y: 0.3 }]),
    source(3, '公司乙\n前端实习', 60, [{ text: '公司乙', y: 0.6 }, { text: '前端实习', y: 0.65 }]),
  ];
  const original = JSON.stringify(sources);
  const context = (retrieval.context as any)(sources, { readingOrder: true });
  expect(context.indexOf('公司甲')).toBeLessThan(context.indexOf('微前端开发'));
  expect(context.indexOf('公司乙')).toBeLessThan(context.indexOf('骨架屏缩短40%'));
  expect(context).toContain('[1]');
  expect(context).toContain('[3]');
  expect(JSON.stringify(sources)).toBe(original);
});
it('keeps the established source format for legacy documents without native geometry', () => {
  const sources: any = [{ number: 1, filename: '旧资料.pdf', text: '没有坐标的原文', location: { page: 1 } }];
  expect((retrieval.context as any)(sources, { readingOrder: true })).toBe(retrieval.context(sources));
});
it('does not repeat text from overlapping chunks that share the same native item', () => {
  const sources: any[] = [
    source(1, '复用按钮', 0, [{ text: '复用按钮', y: 0.3 }]),
    source(2, '用按钮', 1, [{ text: '用按钮', y: 0.3 }]),
  ];
  const context = (retrieval.context as any)(sources, { readingOrder: true });
  expect(context.match(/复用按钮/g)).toHaveLength(1);
  expect(context).not.toContain('复用按钮用按钮');
});
it('keeps uncertain recognition separate from the authoritative native reading order', () => {
  const supplement: any = source(2, '[图片文字识别]\n公司甲', 30, [{ text: '公司甲', y: 0.1 }]);
  supplement.location.anchors[0].kind = 'ocr';
  const sources: any[] = [source(1, '姓名小甲\n公司乙\n骨架屏缩短40%', 0,
    [{ text: '姓名小甲', y: 0.02 }, { text: '公司乙', y: 0.6 }, { text: '骨架屏缩短40%', y: 0.7 }]), supplement];
  const context = (retrieval.context as any)(sources, { readingOrder: true });
  expect(context.indexOf('公司乙')).toBeLessThan(context.indexOf('骨架屏缩短40%'));
  expect(context).toContain('[图片文字识别]');
  expect(context.indexOf('骨架屏缩短40%')).toBeLessThan(context.indexOf('识别补充'));
});
it('preserves established order for ambiguous parallel prose columns', () => {
  const sources: any[] = [];
  for (let row = 0; row < 3; row++) for (const side of [0, 1]) {
    const item = source(sources.length + 1, `段落${row}${side}`, sources.length * 10,
      [{ text: `段落${row}${side}`, y: 0.2 + row * 0.05 }]);
    item.location.anchors[0].rects[0] = [side ? 0.55 : 0.1, 0.2 + row * 0.05, side ? 0.9 : 0.45, 0.22 + row * 0.05];
    sources.push(item);
  }
  expect((retrieval.context as any)(sources, { readingOrder: true })).toBe(retrieval.context(sources));
});
it('preserves column order for OCR paragraphs rather than interleaving left and right blocks', () => {
  const sources: any[] = [];
  for (const side of [0, 1]) for (let row = 0; row < 2; row++) {
    const text = `${side ? 'Right' : 'Left'} column paragraph ${row}`;
    const item: any = source(sources.length + 1, text, sources.length * 40, [{ text, y: 0.2 + row * 0.1 }]);
    item.location.anchors[0].kind = 'ocr';
    item.location.anchors[0].rects[0] = [side ? 0.55 : 0.1, 0.2 + row * 0.1, side ? 0.9 : 0.45, 0.24 + row * 0.1];
    sources.push(item);
  }
  expect((retrieval.context as any)(sources, { readingOrder: true })).toBe(retrieval.context(sources));
});
