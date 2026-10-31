export interface ChatItem {
  knowledgeBaseId?: number;
  readOnly?: boolean;
  id: number;
  title: string;
  createdAt: string;
}

export interface MindMapItem {
  id: number;
  title: string;
  data: string;
  createdAt: string;
}
