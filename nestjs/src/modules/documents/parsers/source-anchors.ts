import type { PdfSourceAnchor, SourceLocation } from './parsed-document';

/** Text slicing and geometry must always travel together, including global offset rebasing. */
export function sliceSourceLocation(
  location: SourceLocation,
  start: number,
  end: number,
  delta = 0,
): SourceLocation {
  return {
    ...location,
    start: start + delta,
    end: end + delta,
    ...(location.anchors
      ? {
          anchorVersion: 1 as const,
          anchors: location.anchors
            .filter((a) => a.start < end && a.end > start)
            .map((a) => ({
              ...a,
              start: Math.max(start, a.start) + delta,
              end: Math.min(end, a.end) + delta,
              rects: a.rects.map((r) => [...r] as typeof r),
            })),
        }
      : {}),
  };
}

export function shiftSourceLocation(location: SourceLocation, delta: number): SourceLocation {
  return sliceSourceLocation(location, location.start, location.end, delta);
}

export function mergeSourceLocations(left: SourceLocation, right: SourceLocation): SourceLocation {
  const anchors = [...(left.anchors || []), ...(right.anchors || [])];
  const unique = new Map<string, PdfSourceAnchor>();
  for (const a of anchors)
    unique.set(JSON.stringify(a), { ...a, rects: a.rects.map((r) => [...r] as typeof r) });
  return {
    ...left,
    start: Math.min(left.start, right.start),
    end: Math.max(left.end, right.end),
    ...(left.anchors || right.anchors
      ? { anchorVersion: 1 as const, anchors: [...unique.values()] }
      : {}),
  };
}

/** Keep geometry in persistent evidence, but out of model tokens and vector payloads. */
export function withoutSourceGeometry<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutSourceGeometry) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'anchors' && key !== 'anchorVersion' && key !== 'sourceSegments' && key !== 'tableRegions' && key !== 'table')
      .map(([key, v]) => [key, withoutSourceGeometry(v)]),
  ) as T;
}
