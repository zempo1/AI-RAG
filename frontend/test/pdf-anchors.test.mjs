import test from 'node:test';
import assert from 'node:assert/strict';

// 坐标由 PDF 的 CropBox、固有旋转及用户旋转手算，不依赖被测函数生成期望值。
const module = await import('../src/features/reader/pdf-anchors.ts').catch(() => ({}));
test('引用框经 PDF 坐标转换，保留每行独立框并适应用户 90 度旋转', () => {
  assert.equal(typeof module.transformAnchorRect, 'function', '缺少 PDF 引用坐标变换');
  const base = { width: 400, height: 600, transform: [1, 0, 0, -1, -20, 630] };
  const current = { width: 1200, height: 800, transform: [0, 2, 2, 0, -60, -40] };
  assert.deepEqual(module.transformAnchorRect([.1, .2, .4, .25], base, current),
    { left: 900, top: 80, width: 60, height: 240 });
});
test('固有旋转的裁剪页面在缩放后仍保留准确位置', () => {
  assert.equal(typeof module.transformAnchorRect, 'function', '缺少 PDF 引用坐标变换');
  const base = { width: 600, height: 400, transform: [0, 1, 1, 0, -30, -20] };
  const current = { width: 800, height: 1200, transform: [-2, 0, 0, 2, 840, -60] };
  assert.deepEqual(module.transformAnchorRect([.1, .2, .4, .25], base, current),
    { left: 600, top: 120, width: 40, height: 360 });
});
test('损坏或超出页面的引用框不会覆盖整份阅读器', () => {
  assert.equal(typeof module.transformAnchorRect, 'function', '缺少 PDF 引用坐标变换');
  const viewport = { width: 400, height: 600, transform: [1, 0, 0, -1, 0, 600] };
  assert.equal(module.transformAnchorRect([NaN, 0, 1, 1], viewport, viewport), null);
  assert.equal(module.transformAnchorRect([.7, .5, .2, .3], viewport, viewport), null);
});
