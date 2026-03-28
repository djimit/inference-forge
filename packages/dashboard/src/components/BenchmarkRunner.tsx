import React, { useState } from 'react';
import { useOllama } from '../hooks/useOllama';

interface BenchmarkRunnerProps {
  models: Array<{ name: string }>;
}

export function BenchmarkRunner({ models }: BenchmarkRunnerProps) {
  const { startBenchmark, getBenchmarkResult, loading } = useOllama();
  const [selectedModel, setSelectedModel] = useState('');
  const [result, setResult] = useState<any>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle');

  const handleRun = async () => {
    if (!selectedModel) return;
    setStatus('running');
    setResult(null);
    await startBenchmark(selectedModel);

    // Poll for result
    const poll = setInterval(async () => {
      const res = await getBenchmarkResult();
      if (res && (res as any).completedAt) {
        clearInterval(poll);
        setResult(res);
        setStatus('done');
      }
    }, 3000);
  };

  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-4">KV Cache Benchmark</h2>

      <div className="flex gap-3 mb-4">
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="flex-1 bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-forge-text"
        >
          <option value="">Select a model...</option>
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
        <button
          onClick={handleRun}
          disabled={!selectedModel || status === 'running'}
          className="px-4 py-2 bg-forge-accent text-white rounded-lg font-medium
                     hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors"
        >
          {status === 'running' ? 'Running...' : 'Run Benchmark'}
        </button>
      </div>

      {status === 'running' && (
        <div className="flex items-center gap-2 text-forge-muted text-sm">
          <div className="w-4 h-4 border-2 border-forge-accent border-t-transparent rounded-full animate-spin" />
          Benchmarking — this may take a few minutes...
        </div>
      )}

      {result && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-forge-muted mb-3">Results</h3>
          <div className="grid grid-cols-3 gap-3">
            {result.summary?.map((s: any) => (
              <div key={s.kvCacheType} className="bg-forge-bg rounded-lg p-4 text-center">
                <div className="text-xs text-forge-muted mb-1">KV Type</div>
                <div className="text-lg font-bold text-forge-accent">{s.kvCacheType}</div>
                <div className="mt-2 text-sm">
                  <div>
                    <span className="text-forge-muted">Speed: </span>
                    <span className="text-forge-text font-medium">
                      {s.avgTokensPerSecond} tok/s
                    </span>
                  </div>
                  <div>
                    <span className="text-forge-muted">Avg time: </span>
                    <span className="text-forge-text font-medium">
                      {(s.avgTotalDurationMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
