import { useState, useCallback } from 'react';

const API_BASE = '/api';

export function useOllama() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiCall = useCallback(async <T>(path: string, options?: RequestInit): Promise<T | null> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options?.headers },
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return await res.json();
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const startBenchmark = useCallback(
    (model: string, kvCacheTypes?: string[]) =>
      apiCall('/benchmark/run', {
        method: 'POST',
        body: JSON.stringify({ model, kvCacheTypes, runs: 2 }),
      }),
    [apiCall]
  );

  const getBenchmarkResult = useCallback(
    () => apiCall('/benchmark/result'),
    [apiCall]
  );

  const generateModelfile = useCallback(
    (hardware: any, config: any) =>
      apiCall('/modelfile/generate', {
        method: 'POST',
        body: JSON.stringify({ hardware, config }),
      }),
    [apiCall]
  );

  return { loading, error, startBenchmark, getBenchmarkResult, generateModelfile, apiCall };
}
