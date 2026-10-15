import type {
  WorktrailDetail, WorktrailDocument, WorktrailEvent, WorktrailResponses, WorktrailReview, WorktrailSearchResult,
} from '../../shared/worktrail-contract';

export interface WorktrailClient {
  status(): Promise<WorktrailResponses['status']>;
  review(options?: { signal?: AbortSignal; onProgress?: (phase: string) => void }): Promise<WorktrailReview>;
  thread(id: number): Promise<WorktrailDetail>;
  history(id: number): Promise<WorktrailResponses['history']>;
  archive(id?: number): Promise<WorktrailResponses['archive']>;
  prior(id: number): Promise<WorktrailResponses['prior']>;
}
export function createWorktrailClient(request?: typeof fetch, options?: { getOrigin?: () => string }): WorktrailClient;
export function completed(state: string): boolean;
export function extractWorktrailFacts(
  detail: WorktrailDetail, events?: WorktrailEvent[],
): { features: string[]; verification: string[]; limits: string[] };
export function composeFactDocument(
  title: string, sources: Array<{ id: number; detail: WorktrailDetail; events: WorktrailEvent[] }>,
): string;
export function createWorktrailSearch(options: {
  load: WorktrailClient['review']; now?: () => number; ttl?: number; timeoutMs?: number;
}): {
  clear(): void;
  search(input?: Record<string, unknown>): Promise<WorktrailSearchResult>;
  state(): { phase: string; error: string | null; checkedAt: number | null };
};
export function createWorktrailDocuments(options: {
  store: {
    getSetting(key: string): WorktrailDocument[];
    setSetting(key: string, value: WorktrailDocument[]): Promise<void>;
  };
  worktrail: WorktrailClient;
  bridge: { call(name: string, input: Record<string, unknown>): Promise<unknown> };
}): {
  list(): WorktrailResponses['documents'];
  get(id: string): WorktrailDocument;
  create(input: Record<string, unknown>): Promise<WorktrailDocument>;
  save(input: Record<string, unknown>): Promise<WorktrailDocument>;
  remove(input: Record<string, unknown>): Promise<WorktrailResponses['remove']>;
  submit(input: Record<string, unknown>): Promise<WorktrailDocument>;
};
