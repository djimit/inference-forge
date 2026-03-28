import React from 'react';

interface VramGaugeProps {
  totalUsed: number;
  perModel: Array<{
    name: string;
    sizeVram: number;
    sizeTotal: number;
    parameterSize: string;
    quantization: string;
  }>;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

export function VramGauge({ totalUsed, perModel }: VramGaugeProps) {
  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-4">VRAM Usage</h2>
      <div className="text-3xl font-bold text-forge-accent mb-4">
        {formatBytes(totalUsed)}
      </div>
      <div className="space-y-3">
        {perModel.map((m) => {
          const pct = m.sizeTotal > 0 ? (m.sizeVram / m.sizeTotal) * 100 : 0;
          return (
            <div key={m.name}>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-forge-text">{m.name}</span>
                <span className="text-forge-muted">
                  {formatBytes(m.sizeVram)} / {formatBytes(m.sizeTotal)}
                </span>
              </div>
              <div className="w-full bg-forge-border rounded-full h-2">
                <div
                  className="bg-forge-accent rounded-full h-2 transition-all duration-500"
                  style={{ width: `${Math.min(pct, 100)}%` }}
                />
              </div>
              <div className="flex gap-2 mt-1 text-xs text-forge-muted">
                <span>{m.parameterSize}</span>
                <span>{m.quantization}</span>
                <span>{pct.toFixed(0)}% GPU offload</span>
              </div>
            </div>
          );
        })}
        {perModel.length === 0 && (
          <p className="text-forge-muted text-sm">No models running</p>
        )}
      </div>
    </div>
  );
}
