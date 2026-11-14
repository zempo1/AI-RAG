import { nativeTableMarkdown } from '../src/modules/documents/parsers/pdf-native-table';
import { TextPosition } from '../src/modules/documents/parsers/pdf-layout';

const text = (value: string, x: number, y: number, width: number): TextPosition =>
  ({ text: value, index: 0, bbox: [x, y, x + width, y + 0.015] });
it('keeps right-aligned numeric values in their original columns', () => {
  const result = nativeTableMarkdown([
    text('First column', 0.1, 0.1, 0.3), text('Second column', 0.5, 0.1, 0.3),
    text('1', 0.39, 0.15, 0.01), text('2', 0.79, 0.15, 0.01),
  ], [0, 0, 1, 1]);
  expect(result).toContain('| 1 | 2 |');
});
it('preserves two narrow columns separated by a real gap', () => {
  const result = nativeTableMarkdown([
    text('A', 0.1, 0.1, 0.01), text('B', 0.13, 0.1, 0.01),
    text('1', 0.1, 0.15, 0.01), text('2', 0.13, 0.15, 0.01),
  ], [0, 0, 1, 1]);
  expect(result).toContain('| A | B |');
  expect(result).toContain('| 1 | 2 |');
});
it('keeps continuation text in the same column and escapes literal table separators', () => {
  const result = nativeTableMarkdown([
    text('First', 0.1, 0.1, 0.1), text('Second', 0.5, 0.1, 0.12),
    text('long value', 0.1, 0.15, 0.15), text('x|y', 0.5, 0.15, 0.05),
    text('continued', 0.1, 0.18, 0.1),
  ], [0, 0, 1, 1]);
  expect(result).toContain('| long value | x\\|y |');
  expect(result).toContain('| continued |  |');
});
