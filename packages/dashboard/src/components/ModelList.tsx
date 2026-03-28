import React from 'react';

interface Model {
  name: string;
  size: number;
  details: {
    parameter_size: string;
    quantization_level: string;
    family: string;
  };
}

interface RunningModel extends Model {
  size_vram: number;
  expires_at: string;
}

interface ModelListProps {
  available: Model[];
  running: RunningModel[];
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export function ModelList({ available, running }: ModelListProps) {
  const runningNames = new Set(running.map((m) => m.name));

  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-4">Models</h2>

      {running.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm font-medium text-forge-success mb-2">Running</h3>
          <div className="space-y-2">
            {running.map((m) => (
              <div
                key={m.name}
                className="flex items-center justify-between bg-forge-bg rounded-lg px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-forge-success animate-pulse" />
                  <span className="font-medium">{m.name}</span>
                </div>
                <div className="flex gap-3 text-xs text-forge-muted">
                  <span>{m.details.parameter_size}</span>
                  <span>{m.details.quantization_level}</span>
                  <span>{formatBytes(m.size)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="text-sm font-medium text-forge-muted mb-2">Available</h3>
        <div className="space-y-1">
          {available
            .filter((m) => !runningNames.has(m.name))
            .map((m) => (
              <div
                key={m.name}
                className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-forge-bg transition-colors"
              >
                <span className="text-forge-muted">{m.name}</span>
                <div className="flex gap-3 text-xs text-forge-muted">
                  <span>{m.details.parameter_size}</span>
                  <span>{m.details.quantization_level}</span>
                  <span>{formatBytes(m.size)}</span>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
