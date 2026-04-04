import React, { useState } from 'react';
import { useOllama } from '../hooks/useOllama';

interface PressurePanelProps {
  pressure: any;
  models?: Array<{ name: string }>;
}

const LEVEL_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  low: { bg: 'bg-forge-success/10', text: 'text-forge-success', dot: 'bg-forge-success' },
  moderate: { bg: 'bg-forge-accent/10', text: 'text-forge-accent', dot: 'bg-forge-accent' },
  high: { bg: 'bg-forge-warning/10', text: 'text-forge-warning', dot: 'bg-forge-warning' },
  critical: { bg: 'bg-forge-danger/10', text: 'text-forge-danger', dot: 'bg-forge-danger' },
};

export function PressurePanel({ pressure, models }: PressurePanelProps) {
  const { predictPressure } = useOllama();
  const [selectedModel, setSelectedModel] = useState('');
  const [prediction, setPrediction] = useState<any>(null);

  if (!pressure) {
    return (
      <div className="bg-forge-card border border-forge-border rounded-xl p-6">
        <h3 className="text-sm font-semibold mb-2">Resource Pressure</h3>
        <p className="text-xs text-forge-muted">Waiting for data...</p>
      </div>
    );
  }

  const style = LEVEL_STYLES[pressure.pressureLevel] || LEVEL_STYLES.low;
  const usedPercent = pressure.vramTotalMb > 0
    ? (pressure.vramUsedMb / pressure.vramTotalMb) * 100
    : 0;

  const handlePredict = async () => {
    if (!selectedModel) return;
    const res = await predictPressure(selectedModel);
    if (res) setPrediction(res);
  };

  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Resource Pressure</h3>
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${style.dot}`} />
          <span className={`text-xs font-medium ${style.text}`}>
            {pressure.pressureLevel}
          </span>
        </div>
      </div>

      {/* VRAM Bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-forge-muted mb-1">
          <span>VRAM</span>
          <span>{pressure.vramUsedMb}MB / {pressure.vramTotalMb}MB</span>
        </div>
        <div className="w-full bg-forge-border rounded-full h-2.5">
          <div
            className={`rounded-full h-2.5 transition-all duration-500 ${
              usedPercent > 90 ? 'bg-forge-danger' : usedPercent > 70 ? 'bg-forge-warning' : 'bg-forge-accent'
            }`}
            style={{ width: `${Math.min(usedPercent, 100)}%` }}
          />
        </div>
      </div>

      {/* Loaded Models */}
      {pressure.loadedModels?.length > 0 && (
        <div className="mb-3 space-y-1">
          {pressure.loadedModels.map((m: any) => (
            <div key={m.name} className="flex justify-between text-xs">
              <span className="text-forge-text truncate mr-2">{m.name}</span>
              <span className="text-forge-muted shrink-0">{m.vramUsageMb}MB</span>
            </div>
          ))}
        </div>
      )}

      {/* Capacity */}
      <div className={`rounded-lg p-2 text-xs ${style.bg}`}>
        <div className={style.text}>{pressure.advice}</div>
        <div className="text-forge-muted mt-1">
          Max concurrent models: ~{pressure.concurrentModelLimit}
        </div>
      </div>

      {/* What-if Prediction */}
      {models && models.length > 0 && (
        <div className="mt-3 pt-3 border-t border-forge-border">
          <div className="text-xs text-forge-muted mb-1">What if I load...</div>
          <div className="flex gap-2">
            <select
              value={selectedModel}
              onChange={(e) => { setSelectedModel(e.target.value); setPrediction(null); }}
              className="flex-1 bg-forge-bg border border-forge-border rounded px-2 py-1 text-xs text-forge-text"
            >
              <option value="">Select model...</option>
              {models.map((m) => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </select>
            <button
              onClick={handlePredict}
              disabled={!selectedModel}
              className="px-2 py-1 bg-forge-accent text-white rounded text-xs disabled:opacity-50"
            >
              Check
            </button>
          </div>
          {prediction && (
            <div className={`mt-2 rounded-lg p-2 text-xs ${prediction.fitsInFreeVram ? 'bg-forge-success/10 text-forge-success' : 'bg-forge-danger/10 text-forge-danger'}`}>
              <div className="font-medium">
                {prediction.fitsInFreeVram ? 'Safe to load' : 'Would cause eviction'}
              </div>
              <div className="text-forge-muted mt-0.5">{prediction.recommendedAction}</div>
              <div className="text-forge-muted">Est. VRAM: {prediction.estimatedVramMb}MB</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
