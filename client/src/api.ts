import type { ApiErrorBody, AskResponse, HistoryItem, SavedAnswer } from './types';

/** An error the API reported, with its stable code (e.g. RATE_LIMITED). */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('NETWORK', 'Cannot reach the AskDB server. Is it running?', null);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? 'Something went wrong.',
      (body as ApiErrorBody | null)?.requestId ?? null,
    );
  }
  return body as T;
}

export function ask(question: string, signal?: AbortSignal): Promise<AskResponse> {
  return request<AskResponse>('/api/ask', { method: 'POST', body: JSON.stringify({ question }), signal });
}

export async function fetchHistory(limit = 20): Promise<HistoryItem[]> {
  const body = await request<{ items: HistoryItem[] }>(`/api/history?limit=${limit}`);
  return body.items;
}

/** A saved answer from this visitor's history: shown again without calling the AI. */
export function fetchSaved(id: string): Promise<SavedAnswer> {
  return request<SavedAnswer>(`/api/history/${encodeURIComponent(id)}`);
}
