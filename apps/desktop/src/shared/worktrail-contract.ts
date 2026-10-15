export interface WorktrailEvent {
  kind?: string;
  note_kind?: string;
  observed?: string;
  text?: string;
  reason?: string;
  at?: number;
}

export interface WorktrailCase {
  case_id?: number;
  title: string;
  state: string;
  phase?: string;
  owner?: string;
  updated_at?: number;
  focus?: string;
  next?: string;
  result?: string;
  events: WorktrailEvent[];
}

export interface WorktrailReview {
  topics: Array<{ id: number; name: string; case_ids: number[] }>;
  cases: Record<string, WorktrailCase>;
  unassigned: number[];
}

export interface WorktrailDetail {
  title: string;
  status: string;
  owner?: string;
  result?: string;
  focus?: { statement?: string };
  next?: { statement?: string; owner?: string };
  constraints?: Array<{ statement?: string; text?: string }>;
}

export interface WorktrailDocument {
  id: string;
  slug: string;
  title: string;
  content: string;
  revision: number;
  status: 'draft' | 'sending' | 'uncertain' | 'submitted';
  createdAt: string;
  updatedAt: string;
  sources: Array<{ id: number; title: string }>;
  remoteDraftId?: number;
  error?: string | null;
}

export interface WorktrailSearchResult {
  query: string;
  results: Array<{
    caseId: number;
    title: string;
    status: string;
    topic: string;
    matches: Array<{ kind: string; at: number; snippet: string }>;
  }>;
  total: number;
  nextOffset: number | null;
  checkedAt: number;
}

export interface WorktrailSession {
  id: number;
  session_id?: number;
  title?: string;
  source?: string;
  first_instruction?: string;
  started_at?: number;
}

export interface WorktrailResponses {
  status: { counts: Record<string, number> };
  review: WorktrailReview;
  thread: WorktrailDetail;
  history: {
    conversation: Array<{ id: number; role: string; content: string; created_at: number }>;
    turns: unknown[];
  };
  search: WorktrailSearchResult;
  archive: {
    workspaces?: Array<{ repo_id: number; repo: string; sessions: number }>;
    sessions?: WorktrailSession[];
  };
  prior: { source?: string; branch?: string; cwd?: string; items?: Array<{ seq: number; text: string }> };
  documents: Omit<WorktrailDocument, 'content'>[];
  document: WorktrailDocument;
  create: WorktrailDocument;
  save: WorktrailDocument;
  remove: { deleted: boolean; id: string };
  submit: WorktrailDocument;
  'wiki-status': { connected: boolean; pending: number };
}

export type WorktrailAction = keyof WorktrailResponses;
