import { useState, useCallback } from 'react';

const API_BASE = '/api';

interface HardwareProfile {
  gpuVramMb: number;
  systemRamMb: number;
  gpuName: string;
  cpuCores: number;
  cpuPhysicalCores: number;
  pcieGeneration: number | null;
  pcieBandwidthGBs: number | null;
}

interface ModelfileConfig {
  baseModel: string;
  customName: string;
  useCase: string;
}

interface ExpandedBenchmarkConfig {
  mode: string;
  model: string;
  runs: number;
  gpuLayerSteps?: number[];
  threadCountSteps?: number[];
  contextLengthSteps?: number[];
  batchSizeSteps?: number[];
}

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
    (hardware: HardwareProfile, config: ModelfileConfig) =>
      apiCall('/modelfile/generate', {
        method: 'POST',
        body: JSON.stringify({ hardware, config }),
      }),
    [apiCall]
  );

  const generateModelfileAuto = useCallback(
    (config: ModelfileConfig) =>
      apiCall('/modelfile/generate-auto', {
        method: 'POST',
        body: JSON.stringify({ config }),
      }),
    [apiCall]
  );

  const getHardware = useCallback(
    () => apiCall('/hardware/last'),
    [apiCall]
  );

  const startExpandedBenchmark = useCallback(
    (config: ExpandedBenchmarkConfig) =>
      apiCall('/benchmark/run-expanded', {
        method: 'POST',
        body: JSON.stringify(config),
      }),
    [apiCall]
  );

  const getBenchmarkHistory = useCallback(
    () => apiCall('/benchmark/history'),
    [apiCall]
  );

  const getPressure = useCallback(
    () => apiCall('/pressure'),
    [apiCall]
  );

  const predictPressure = useCallback(
    (model: string) =>
      apiCall('/pressure/predict', {
        method: 'POST',
        body: JSON.stringify({ model }),
      }),
    [apiCall]
  );

  const getIoProfile = useCallback(
    () => apiCall('/io/profile'),
    [apiCall]
  );

  return {
    loading, error, apiCall,
    startBenchmark, getBenchmarkResult, generateModelfile,
    generateModelfileAuto, getHardware,
    startExpandedBenchmark, getBenchmarkHistory,
    getPressure, predictPressure, getIoProfile,
  };
}
