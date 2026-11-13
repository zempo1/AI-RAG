export type NormalizedRect = [number, number, number, number];
export interface AnchorViewport { width: number; height: number; transform: number[] }

/** 锚点以固有旋转、CropBox 后的 scale=1 viewport 为基准；经 PDF 空间转换。 */
export function transformAnchorRect(rect: NormalizedRect, base: AnchorViewport, current: AnchorViewport) {
  if (rect.some(v => !Number.isFinite(v) || v < 0 || v > 1) || rect[2] <= rect[0] || rect[3] <= rect[1]) return null;
  const [a,b,c,d,e,f] = base.transform;
  const determinant = a*d-b*c;
  if (!determinant) return null;
  const [A,B,C,D,E,F] = current.transform;
  const points = [[rect[0],rect[1]],[rect[2],rect[1]],[rect[0],rect[3]],[rect[2],rect[3]]].map(([x,y]) => {
    const vx=x*base.width-e, vy=y*base.height-f;
    const px=(d*vx-c*vy)/determinant, py=(-b*vx+a*vy)/determinant;
    return [A*px+C*py+E,B*px+D*py+F];
  });
  const left=Math.min(...points.map(p=>p[0])), top=Math.min(...points.map(p=>p[1]));
  return { left, top, width:Math.max(...points.map(p=>p[0]))-left, height:Math.max(...points.map(p=>p[1]))-top };
}
