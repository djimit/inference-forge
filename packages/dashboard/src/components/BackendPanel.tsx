import React, { useState, useEffect, useCallback } from 'react';
import { useOllama } from '../hooks/useOllama';

interface BackendStatus {
  backend: string;
  running: boolean;
  url: string;
  modelCount: number;
  loadedCount: number;
}

interface UnifiedModel {
  id: string;
  name: string;
  backend: string;
  backendModelId: string;
  type: string;
  sizeMb: number;
  parameterSize: string;
  architecture: string;
  quantization: string;
  maxContextLength: number;
  vision: boolean;
  toolUse: boolean;
  loaded: boolean;
  vramUsageMb: number | null;
  duplicate: string | null;
}

interface Duplicate {
  model1: string;
  model2: string;
  reason: string;
}

interface RegistrySnapshot {
  timestamp: number;
  backends: BackendStatus[];
  models: UnifiedModel[];
  duplicates: Duplicate[];
  totalStorageMb: number;
  totalStorageByBackend: Record<string, number>;
}

function formatSize(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

const backendColors: Record<string, string> = {
  ollama: 'bg-forge-success',
  lmstudio: 'bg-indigo-500',
};

const backendLabels: Record<string, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

export function BackendPanel() {
  const { apiCall } = useOllama();
  const [registry, setRegistry] = useState<RegistrySnapshot | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [starting, setStarting] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiCall<RegistrySnapshot>('/registry');
    if (res) setRegistry(res);
  }, [apiCall]);

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  const handleToggleLms = async (running: boolean) => {
    setStarting('lmstudio');
    await apiCall(`/lmstudio/${running ? 'stop' : 'start'}`, { method: 'POST' });
    setTimeout(load, 2000);
    setStarting(null);
  };

  if (!registry) {
    return (
      <div className="bg-forge-card border border-forge-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-2">Backends</h2>
        <p className="text-forge-muted text-sm">Loading registry...</p>
      </div>
    );
  }

  const filteredModels = filter === 'all'
    ? registry.models
    : registry.models.filter((m) => m.backend === filter);

  const totalModels = registry.models.length;
  const loadedModels = registry.models.filter((m) => m.loaded).length;

  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">
          Inference Backends
          <span className="ml-2 text-xs font-normal text-forge-muted">
            {totalModels} models / {loadedModels} loaded
          </span>
        </h2>
      </div>

      {/* Backend Status Cards */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        {registry.backends.map((b) => (
          <div key={b.backend} className="p-3 bg-forge-bg rounded-lg">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${b.running ? backendColors[b.backend] || 'bg-forge-success' : 'bg-forge-danger'}`} />
                <span className="text-sm font-medium">{backendLabels[b.backend] || b.backend}</span>
              </div>
              {b.backend === 'lmstudio' && (
                <button
                  onClick={() => handleToggleLms(b.running)}
                  disabled={starting === 'lmstudio'}
                  className="text-xs px-2 py-0.5 rounded bg-forge-accent/20 text-forge-accent hover:bg-forge-accent/30 transition-colors disabled:opacity-50"
                >
                  {starting === 'lmstudio' ? '...' : b.running ? 'Stop' : 'Start'}
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
              <div>
                <span className="text-forge-muted">Models</span>
                <div className="text-forge-text font-medium">{b.modelCount}</div>
              </div>
              <div>
                <span className="text-forge-muted">Loaded</span>
                <div className="text-forge-text font-medium">{b.loadedCount}</div>
              </div>
            </div>
            <div className="text-xs text-forge-muted mt-1">
              {formatSize(registry.totalStorageByBackend[b.backend] || 0)} on disk
            </div>
          </div>
        ))}
      </div>

      {/* Duplicate Warnings */}
      {registry.duplicates.length > 0 && (
        <div className="mb-4 p-3 bg-forge-warning/10 border border-forge-warning/30 rounded-lg">
          <div className="text-xs font-medium text-forge-warning mb-1">
            {registry.duplicates.length} duplicate{registry.duplicates.length > 1 ? 's' : ''} detected
          </div>
          {registry.duplicates.map((d, i) => (
            <div key={i} className="text-xs text-forge-muted">{d.reason}</div>
          ))}
        </div>
      )}

      {/* Storage Summary */}
      <div className="mb-4 p-3 bg-forge-bg rounded-lg">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-forge-muted">Total Model Storage</span>
          <span className="text-forge-text font-medium">{formatSize(registry.totalStorageMb)}</span>
        </div>
        <div className="w-full bg-forge-border rounded-full h-1.5 flex overflow-hidden">
          {registry.backends.map((b) => {
            const pct = registry.totalStorageMb > 0
              ? ((registry.totalStorageByBackend[b.backend] || 0) / registry.totalStorageMb) * 100
              : 0;
            return (
              <div
                key={b.backend}
                className={`h-1.5 ${backendColors[b.backend] || 'bg-forge-accent'}`}
                style={{ width: `${pct}%` }}
              />
            );
          })}
        </div>
        <div className="flex gap-3 mt-1">
          {registry.backends.map((b) => (
            <div key={b.backend} className="flex items-center gap-1 text-xs text-forge-muted">
              <div className={`w-2 h-2 rounded-full ${backendColors[b.backend]}`} />
              {backendLabels[b.backend]}: {formatSize(registry.totalStorageByBackend[b.backend] || 0)}
            </div>
          ))}
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-1 mb-3">
        {['all', ...registry.backends.map((b) => b.backend)].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              filter === f
                ? 'bg-forge-accent text-white'
                : 'bg-forge-bg text-forge-muted hover:text-forge-text'
            }`}
          >
            {f === 'all' ? 'All' : backendLabels[f] || f}
          </button>
        ))}
      </div>

      {/* Model List */}
      <div className="space-y-1 max-h-72 overflow-y-auto">
        {filteredModels.map((model) => (
          <div
            key={model.id}
            className={`flex items-center justify-between p-2 rounded-lg text-xs ${
              model.loaded ? 'bg-forge-accent/10 border border-forge-accent/30' : 'bg-forge-bg'
            } ${model.duplicate ? 'opacity-70' : ''}`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${backendColors[model.backend]}`} />
              <div className="truncate">
                <span className="font-medium text-forge-text">{model.name}</span>
                {model.loaded && (
                  <span className="ml-1 text-forge-success">(loaded)</span>
                )}
                {model.duplicate && (
                  <span className="ml-1 text-forge-warning">(dup)</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0 text-forge-muted">
              <span>{model.parameterSize}</span>
              <span>{model.quantization}</span>
              <span>{formatSize(model.sizeMb)}</span>
              {model.type === 'embedding' && (
                <span className="px-1 py-0.5 rounded bg-forge-border text-forge-muted">embed</span>
              )}
              {model.vision && (
                <span className="px-1 py-0.5 rounded bg-forge-border text-forge-muted">vision</span>
              )}
              {model.toolUse && (
                <span className="px-1 py-0.5 rounded bg-forge-border text-forge-muted">tools</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
