import React from 'react';

interface GpuInfo {
  index: number;
  name: string;
  vendor: string;
  vramTotalMb: number;
  vramUsedMb: number;
  vramFreeMb: number;
  utilizationPercent: number;
  temperatureCelsius: number | null;
  powerDrawWatts: number | null;
  driverVersion: string;
}

interface HardwarePanelProps {
  hardware: {
    system: { platform: string; cpuModel: string; cpuCores: number; ramTotalMb: number; ramFreeMb: number; ramUsedMb: number };
    gpus: GpuInfo[];
    totalGpuVramMb: number;
    totalGpuVramUsedMb: number;
  } | null;
}

function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function tempColor(temp: number | null): string {
  if (temp === null) return 'text-forge-muted';
  if (temp >= 90) return 'text-forge-danger';
  if (temp >= 75) return 'text-forge-warning';
  return 'text-forge-success';
}

export function HardwarePanel({ hardware: hw }: HardwarePanelProps) {
  if (!hw) {
    return (
      <div className="bg-forge-card border border-forge-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-2">Hardware</h2>
        <p className="text-forge-muted text-sm">Detecting hardware...</p>
      </div>
    );
  }

  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-4">Hardware</h2>

      {/* System */}
      <div className="mb-4 p-3 bg-forge-bg rounded-lg text-sm">
        <div className="flex justify-between">
          <span className="text-forge-muted">CPU</span>
          <span className="text-forge-text">{hw.system.cpuModel.split('@')[0].trim()}</span>
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-forge-muted">Cores</span>
          <span className="text-forge-text">{hw.system.cpuCores}</span>
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-forge-muted">RAM</span>
          <span className="text-forge-text">
            {formatMb(hw.system.ramUsedMb)} / {formatMb(hw.system.ramTotalMb)}
          </span>
        </div>
        <div className="w-full bg-forge-border rounded-full h-1.5 mt-2">
          <div
            className="bg-forge-accent rounded-full h-1.5 transition-all"
            style={{ width: `${(hw.system.ramUsedMb / hw.system.ramTotalMb) * 100}%` }}
          />
        </div>
      </div>

      {/* GPUs */}
      {hw.gpus.map((gpu) => (
        <div key={gpu.index} className="mb-3 p-3 bg-forge-bg rounded-lg">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-medium">{gpu.name}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-forge-accent/20 text-forge-accent">
              {gpu.vendor}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-forge-muted">VRAM</span>
              <div className="text-forge-text font-medium">
                {formatMb(gpu.vramUsedMb)} / {formatMb(gpu.vramTotalMb)}
              </div>
            </div>
            <div>
              <span className="text-forge-muted">Utilization</span>
              <div className="text-forge-text font-medium">{gpu.utilizationPercent}%</div>
            </div>
            <div>
              <span className="text-forge-muted">Temperature</span>
              <div className={`font-medium ${tempColor(gpu.temperatureCelsius)}`}>
                {gpu.temperatureCelsius !== null ? `${gpu.temperatureCelsius}°C` : 'N/A'}
              </div>
            </div>
            <div>
              <span className="text-forge-muted">Power</span>
              <div className="text-forge-text font-medium">
                {gpu.powerDrawWatts !== null ? `${gpu.powerDrawWatts}W` : 'N/A'}
              </div>
            </div>
          </div>
          <div className="w-full bg-forge-border rounded-full h-1.5 mt-2">
            <div
              className={`rounded-full h-1.5 transition-all ${
                gpu.vramTotalMb > 0 && (gpu.vramUsedMb / gpu.vramTotalMb) > 0.9
                  ? 'bg-forge-danger'
                  : 'bg-forge-accent'
              }`}
              style={{ width: `${gpu.vramTotalMb > 0 ? (gpu.vramUsedMb / gpu.vramTotalMb) * 100 : 0}%` }}
            />
          </div>
        </div>
      ))}

      {hw.gpus.length === 0 && (
        <p className="text-forge-muted text-sm">No dedicated GPU detected (using CPU inference)</p>
      )}
    </div>
  );
}
