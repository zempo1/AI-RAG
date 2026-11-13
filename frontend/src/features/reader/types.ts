import type { Citation } from '../../api/knowledge-bases';
export interface DocumentTarget {
  documentId: number;
  versionId?: number;
  citation?: Citation;
}
