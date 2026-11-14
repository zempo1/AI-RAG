import type { RegionBox } from './parsed-document';
import type { TextPosition } from './pdf-layout';

/** Preserve rows and visible cell gaps without inferring labels or rewriting values. */
export function nativeTableMarkdown(texts: TextPosition[], box: RegionBox): string | undefined {
  const items = texts.filter(
    ({ text, bbox: b }) =>
      text.trim() && b[0] >= box[0] && b[1] >= box[1] && b[2] <= box[2] && b[3] <= box[3],
  );
  const rows: TextPosition[][] = [];
  for (const item of items.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])) {
    const center = (item.bbox[1] + item.bbox[3]) / 2;
    const row = rows.find(
      ([first]) =>
        Math.abs(center - (first.bbox[1] + first.bbox[3]) / 2) <
        Math.max(item.bbox[3] - item.bbox[1], first.bbox[3] - first.bbox[1]) * 0.45,
    );
    if (row) row.push(item);
    else rows.push([item]);
  }
  if (rows.length < 2) return undefined;
  const cells = rows.map((row) => {
    const result: { left: number; right: number; text: string }[] = [];
    const widths = row
      .map((item) => (item.bbox[2] - item.bbox[0]) / Array.from(item.text.trim()).length)
      .sort((a, b) => a - b);
    const gap = Math.min(0.018, Math.max(0.001, widths[Math.floor(widths.length / 2)] * 1.5));
    for (const item of row.sort((a, b) => a.bbox[0] - b.bbox[0])) {
      const previous = result.at(-1);
      if (previous && item.bbox[0] - previous.right <= gap) {
        const space =
          item.bbox[0] - previous.right > 0.002 &&
          /[a-z0-9]$/i.test(previous.text) &&
          /^[a-z0-9]/i.test(item.text)
            ? ' '
            : '';
        previous.text += space + item.text;
        previous.right = Math.max(previous.right, item.bbox[2]);
      } else result.push({ left: item.bbox[0], right: item.bbox[2], text: item.text });
    }
    return result;
  });
  const columns = cells.reduce((best, row) => (row.length > best.length ? row : best), cells[0]);
  // Gutters between column intervals also support right- and center-aligned values.
  // A cell crossing a gutter is ambiguous (e.g. a spanning cell): use vision instead.
  const boundaries = [
    box[0],
    ...columns.slice(1).map((cell, i) => (columns[i].right + cell.left) / 2),
    box[2],
  ];
  const escape = (text: string) => text.trim().replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  const format = (row: string[]) => '| ' + row.join(' | ') + ' |';
  // Empty headers avoid falsely treating a title or the first data row as column names.
  const output = [format(columns.map(() => '')), format(columns.map(() => '---'))];
  for (const row of cells) {
    const values = columns.map(() => '');
    for (const cell of row) {
      const column = columns.findIndex(
        (_c, i) => cell.left >= boundaries[i] - 0.001 && cell.right <= boundaries[i + 1] + 0.001,
      );
      if (column < 0 || values[column]) return undefined;
      values[column] += (values[column] ? ' ' : '') + escape(cell.text);
    }
    output.push(format(values));
  }
  return output.join('\n');
}
