import React, { useState } from 'react';
import { useOllama } from '../hooks/useOllama';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { BenchmarkProgress } from '../hooks/useWebSocket';

type BenchmarkMode = 'kv-cache' | 'gpu-offload' | 'thread-count' | 'context-length' | 'batch-size';

interface BenchmarkRunnerProps {
  models: Array<{ name: string }>;
  benchmarkProgress?: BenchmarkProgress | null;
}

const MODES: { id: BenchmarkMode; label: string; description: string }[] = [
  { id: 'kv-cache', label: 'KV Cache', description: 'Compare f16, q8_0, q4_0 cache types' },
  { id: 'gpu-offload', label: 'GPU Offload', description: 'Sweep GPU layer count' },
  { id: 'thread-count', label: 'Threads', description: 'Sweep CPU thread count' },
  { id: 'context-length', label: 'Context', description: 'Test context window sizes' },
  { id: 'batch-size', label: 'Batch Size', description: 'Sweep batch processing size' },
];

const DEFAULT_STEPS: Record<BenchmarkMode, number[]> = {
  'kv-cache': [],
  'gpu-offload': [0, 8, 16, 24, 32],
  'thread-count': [1, 4, 8, 12, 16, 20, 24],
  'context-length': [2048, 4096, 8192, 16384],
  'batch-size': [128, 256, 512, 1024, 2048],
};

export function BenchmarkRunner({ models, benchmarkProgress }: BenchmarkRunnerProps) {
  const { startBenchmark, startExpandedBenchmark, apiCall } = useOllama();
  const [selectedModel, setSelectedModel] = useState('');
  const [mode, setMode] = useState<BenchmarkMode>('kv-cache');
  const [result, setResult] = useState<any>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle');

  const handleRun = async () => {
    if (!selectedModel) return;
    setStatus('running');
    setResult(null);

    if (mode === 'kv-cache') {
      await startBenchmark(selectedModel);
    } else {
      const stepsKey: Record<string, string> = {
        'gpu-offload': 'gpuLayerSteps',
        'thread-count': 'threadCountSteps',
        'context-length': 'contextLengthSteps',
        'batch-size': 'batchSizeSteps',
      };
      await startExpandedBenchmark({
        mode,
        model: selectedModel,
        runs: 2,
        [stepsKey[mode]]: DEFAULT_STEPS[mode],
      });
    }

    // Poll for result
    const endpoint = mode === 'kv-cache' ? '/benchmark/result' : '/benchmark/result-expanded';
    const poll = setInterval(async () => {
      const res = await apiCall(endpoint);
      if (res && (res as any).completedAt) {
        clearInterval(poll);
        setResult(res);
        setStatus('done');
      }
    }, 3000);
  };

  const summaryData = result?.summary?.map((s: any) => ({
    name: s.label || s.kvCacheType || '',
    'Tok/s': s.avgTokensPerSecond,
    'Prompt Tok/s': s.avgPromptEvalTps || 0,
  })) || [];

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-forge-card border border-forge-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Benchmark Runner</h2>

        {/* Mode Selector */}
        <div className="flex gap-1 bg-forge-bg border border-forge-border rounded-lg p-1 mb-4">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                mode === m.id
                  ? 'bg-forge-accent text-white'
                  : 'text-forge-muted hover:text-forge-text hover:bg-forge-card'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <p className="text-xs text-forge-muted mb-3">
          {MODES.find((m) => m.id === mode)?.description}
          {mode !== 'kv-cache' && (
            <span className="ml-2 text-forge-accent">
              Steps: {DEFAULT_STEPS[mode].join(', ')}
            </span>
          )}
        </p>

        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="block text-xs text-forge-muted mb-1">Model</label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-forge-text"
            >
              <option value="">Select model...</option>
              {models.map((m) => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </select>
          </div>
          <button
            onClick={handleRun}
            disabled={!selectedModel || status === 'running'}
            className="px-4 py-2 bg-forge-accent text-white rounded-lg font-medium
                       hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {status === 'running' ? 'Running...' : 'Run Benchmark'}
          </button>
        </div>
      </div>

      {/* Progress */}
      {status === 'running' && benchmarkProgress && (
        <div className="bg-forge-card border border-forge-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-forge-text">{benchmarkProgress.message}</span>
            <span className="text-xs text-forge-muted">
              {Math.round(benchmarkProgress.progress * 100)}%
            </span>
          </div>
          <div className="w-full bg-forge-border rounded-full h-2">
            <div
              className="bg-forge-accent rounded-full h-2 transition-all duration-500"
              style={{ width: `${Math.round(benchmarkProgress.progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      {status === 'running' && !benchmarkProgress && (
        <div className="bg-forge-card border border-forge-border rounded-xl p-6">
          <div className="flex items-center gap-2 text-forge-muted text-sm">
            <div className="w-4 h-4 border-2 border-forge-accent border-t-transparent rounded-full animate-spin" />
            Benchmarking — this may take a few minutes...
          </div>
        </div>
      )}

      {/* Results */}
      {result && summaryData.length > 0 && (
        <div className="bg-forge-card border border-forge-border rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4">
            Results — {result.model} ({MODES.find((m) => m.id === (result.mode || 'kv-cache'))?.label})
          </h3>

          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={summaryData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
              <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 12 }} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1a1d2e', border: '1px solid #2a2d3e', borderRadius: '8px' }}
                labelStyle={{ color: '#e2e8f0' }}
                itemStyle={{ color: '#e2e8f0' }}
              />
              <Bar dataKey="Tok/s" fill="#6366f1" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Prompt Tok/s" fill="#22c55e" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>

          {/* Summary Table */}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-forge-muted text-xs border-b border-forge-border">
                  <th className="text-left py-2 px-2">Config</th>
                  <th className="text-right py-2 px-2">Tok/s</th>
                  <th className="text-right py-2 px-2">Prompt Tok/s</th>
                  <th className="text-right py-2 px-2">Avg Duration</th>
                  <th className="text-right py-2 px-2">Runs</th>
                </tr>
              </thead>
              <tbody>
                {result.summary.map((s: any, i: number) => (
                  <tr key={i} className="border-b border-forge-border/50">
                    <td className="py-2 px-2 text-forge-text font-medium">
                      {s.label || s.kvCacheType}
                    </td>
                    <td className="py-2 px-2 text-right text-forge-accent font-mono">
                      {s.avgTokensPerSecond}
                    </td>
                    <td className="py-2 px-2 text-right text-forge-success font-mono">
                      {s.avgPromptEvalTps || '-'}
                    </td>
                    <td className="py-2 px-2 text-right text-forge-muted font-mono">
                      {(s.avgTotalDurationMs / 1000).toFixed(1)}s
                    </td>
                    <td className="py-2 px-2 text-right text-forge-muted">
                      {s.totalRuns}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
