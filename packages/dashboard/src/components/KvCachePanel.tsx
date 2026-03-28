import React from 'react';

interface KvCacheEstimate {
  name: string;
  estimatedKvBytes: number;
  kvCacheType: string;
  numCtx: number;
}

interface KvCachePanelProps {
  estimates: KvCacheEstimate[];
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}

const KV_TYPE_COLORS: Record<string, string> = {
  f16: 'text-forge-warning',
  q8_0: 'text-forge-accent',
  q4_0: 'text-forge-success',
};

export function KvCachePanel({ estimates }: KvCachePanelProps) {
  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-4">KV Cache</h2>
      <div className="space-y-4">
        {estimates.map((est) => (
          <div key={est.name} className="bg-forge-bg rounded-lg p-4">
            <div className="flex justify-between items-center mb-2">
              <span className="font-medium">{est.name}</span>
              <span className={`text-sm font-mono ${KV_TYPE_COLORS[est.kvCacheType] || ''}`}>
                {est.kvCacheType}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm text-forge-muted">
              <div>
                <span className="block text-xs">Estimated Size</span>
                <span className="text-forge-text font-medium">
                  {formatBytes(est.estimatedKvBytes)}
                </span>
              </div>
              <div>
                <span className="block text-xs">Context Window</span>
                <span className="text-forge-text font-medium">
                  {est.numCtx.toLocaleString()} tokens
                </span>
              </div>
            </div>
          </div>
        ))}
        {estimates.length === 0 && (
          <p className="text-forge-muted text-sm">No running models to estimate</p>
        )}
      </div>
      <div className="mt-4 p-3 bg-forge-bg rounded-lg text-xs text-forge-muted">
        <strong>Tip:</strong> Set <code className="text-forge-accent">OLLAMA_KV_CACHE_TYPE=q8_0</code> to
        halve KV cache memory with minimal quality loss.
      </div>
    </div>
  );
}
