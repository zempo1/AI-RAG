import { RegionBox } from './parsed-document';

const median = (values: number[]) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
};

/** OCR line boxes contain whitespace between lines, so ink area is not coverage.
 * Check every layout text component independently and return only visible gaps.
 */
export function missingOcrText(expected: RegionBox[], actual: RegionBox[]): RegionBox[] {
  const missing: RegionBox[] = [];
  for (const box of expected) {
    const [left, top, right, bottom] = box;
    const pieces = actual
      .map(
        (b) =>
          [
            Math.max(left, b[0]),
            Math.max(top, b[1]),
            Math.min(right, b[2]),
            Math.min(bottom, b[3]),
          ] as RegionBox,
      )
      .filter((b) => b[2] > b[0] && b[3] > b[1])
      .sort((a, b) => a[1] - b[1]);
    if (!pieces.length) {
      missing.push(box);
      continue;
    }
    const rows: RegionBox[] = [];
    for (const piece of pieces) {
      const row = rows.find(
        (b) =>
          Math.min(b[3], piece[3]) - Math.max(b[1], piece[1]) >
          Math.min(b[3] - b[1], piece[3] - piece[1]) * 0.25,
      );
      if (row) {
        row[0] = Math.min(row[0], piece[0]);
        row[1] = Math.min(row[1], piece[1]);
        row[2] = Math.max(row[2], piece[2]);
        row[3] = Math.max(row[3], piece[3]);
      } else rows.push([...piece]);
    }
    rows.sort((a, b) => a[1] - b[1]);
    const lineHeight = median(rows.map((b) => b[3] - b[1]));
    const spacing = Math.max(
      lineHeight,
      median(rows.slice(1).map((b, i) => (b[1] + b[3] - rows[i][1] - rows[i][3]) / 2)),
    );
    const edgeTolerance = Math.max(lineHeight * 0.8, Math.min(spacing * 0.8, lineHeight * 1.8));
    const gapTolerance = Math.max(
      lineHeight * 0.9,
      Math.min((spacing - lineHeight) * 1.8, lineHeight * 2.5),
    );
    const padding = lineHeight * 0.2;
    if (rows[0][1] - top > edgeTolerance)
      missing.push([left, top, right, Math.min(bottom, rows[0][1] + padding)]);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] - rows[i - 1][3] > gapTolerance)
        missing.push([
          left,
          Math.max(top, rows[i - 1][3] - padding),
          right,
          Math.min(bottom, rows[i][1] + padding),
        ]);
    }
    if (bottom - rows.at(-1)![3] > edgeTolerance)
      missing.push([left, Math.max(top, rows.at(-1)![3] - padding), right, bottom]);
    // Long rows establish paragraph width. A short final line is normal, while
    // OCR confined to a narrow column must not account for a wider text region.
    const longest = Math.max(...rows.map((b) => b[2] - b[0]));
    if (longest < (right - left) * 0.55) {
      const minX = Math.min(...rows.map((b) => b[0])),
        maxX = Math.max(...rows.map((b) => b[2]));
      const tolerance = (right - left) * 0.15;
      if (minX - left > tolerance) missing.push([left, top, minX, bottom]);
      if (right - maxX > tolerance) missing.push([maxX, top, right, bottom]);
      if (minX - left <= tolerance && right - maxX <= tolerance) missing.push(box);
    }
  }
  return missing;
}
