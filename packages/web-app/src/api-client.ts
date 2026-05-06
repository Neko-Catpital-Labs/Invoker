export interface HealthResponse {
  status: string;
}

export interface HelloResponse {
  message: string;
}

export interface ApiError {
  error: string;
}

const DEFAULT_BASE_URL = '/api';

export function createApiClient(baseUrl: string = DEFAULT_BASE_URL) {
  async function fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: 'Unknown error' }))) as ApiError;
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  return {
    health: () => fetchJson<HealthResponse>('/health'),
    hello: () => fetchJson<HelloResponse>('/hello'),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
