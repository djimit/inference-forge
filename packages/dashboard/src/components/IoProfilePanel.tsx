import React, { useState, useEffect } from 'react';
import { useOllama } from '../hooks/useOllama';

const DRIVE_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  nvme: { label: 'NVMe', color: 'text-forge-success' },
  ssd: { label: 'SSD', color: 'text-forge-accent' },
  hdd: { label: 'HDD', color: 'text-forge-warning' },
  unknown: { label: 'Unknown', color: 'text-forge-muted' },
};

export function IoProfilePanel() {
  const { getIoProfile, apiCall } = useOllama();
  const [profile, setProfile] = useState<any>(null);
  const [benchmarkStatus, setBenchmarkStatus] = useState<'idle' | 'running' | 'done'>('idle');

  useEffect(() => {
    getIoProfile().then((res) => { if (res) setProfile(res); });
  }, [getIoProfile]);

  const handleBenchmark = async () => {
    setBenchmarkStatus('running');
    await apiCall('/io/benchmark', { method: 'POST' });

    const poll = setInterval(async () => {
      const res = await apiCall<any>('/io/benchmark/result');
      if (res && !res.running) {
        clearInterval(poll);
        setBenchmarkStatus('done');
        // Refresh profile to get updated bandwidth
        const updated = await getIoProfile();
        if (updated) setProfile(updated);
      }
    }, 2000);
  };

  if (!profile) {
    return (
      <div className="bg-forge-card border border-forge-border rounded-xl p-6">
        <h3 className="text-sm font-semibold mb-2">I/O Profile</h3>
        <p className="text-xs text-forge-muted">Loading...</p>
      </div>
    );
  }

  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">Storage & I/O Profile</h3>
        <button
          onClick={handleBenchmark}
          disabled={benchmarkStatus === 'running'}
          className="px-3 py-1 bg-forge-accent text-white rounded text-xs disabled:opacity-50"
        >
          {benchmarkStatus === 'running' ? 'Measuring...' : 'Measure Speed'}
        </button>
      </div>

      {/* Model Directory */}
      <div className="text-xs text-forge-muted mb-3">
        <span>Model dir: </span>
        <span className="text-forge-text font-mono">{profile.ollamaModelDir}</span>
      </div>

      {/* Read Bandwidth */}
      {profile.readBandwidthMBs && (
        <div className="mb-3 bg-forge-bg rounded-lg p-3">
          <div className="text-xs text-forge-muted">Sequential Read Speed</div>
          <div className="text-xl font-bold text-forge-accent">{profile.readBandwidthMBs} MB/s</div>
        </div>
      )}

      {/* Drives */}
      {profile.drives?.length > 0 && (
        <div className="mb-3">
          <div className="text-xs text-forge-muted mb-1">Detected Drives</div>
          <div className="space-y-1">
            {profile.drives.map((d: any, i: number) => {
              const dt = DRIVE_TYPE_LABELS[d.type] || DRIVE_TYPE_LABELS.unknown;
              return (
                <div key={i} className="flex justify-between text-xs">
                  <span className="text-forge-text truncate mr-2">{d.path}</span>
                  <div className="flex gap-2 shrink-0">
                    <span className={dt.color}>{dt.label}</span>
                    <span className="text-forge-muted">{d.sizeTotalGb}GB</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Model Storage */}
      {profile.modelStorage?.length > 0 && (
        <div className="mb-3">
          <div className="text-xs text-forge-muted mb-1">Model Placement ({profile.modelStorage.length} models)</div>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {profile.modelStorage.slice(0, 20).map((m: any, i: number) => {
              const dt = DRIVE_TYPE_LABELS[m.driveType] || DRIVE_TYPE_LABELS.unknown;
              return (
                <div key={i} className="flex justify-between text-xs">
                  <span className="text-forge-text truncate mr-2">{m.modelName}</span>
                  <span className={dt.color}>{dt.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {profile.recommendations?.length > 0 && (
        <div className="space-y-1">
          {profile.recommendations.map((r: string, i: number) => (
            <div key={i} className="text-xs text-forge-warning bg-forge-warning/10 rounded p-2">
              {r}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
