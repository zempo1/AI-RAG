import { RequestScheduler as VisionScheduler } from '../../../common/request-scheduler';

export { VisionScheduler };
export const localRendering = new VisionScheduler(1);
const pools = new Map<number, VisionScheduler>();
export function visionPool(limit: number) {
  if (!pools.has(limit)) pools.set(limit, new VisionScheduler(limit));
  return pools.get(limit)!;
}
