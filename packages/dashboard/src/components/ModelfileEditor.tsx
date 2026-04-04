import React, { useState } from 'react';
import { useOllama } from '../hooks/useOllama';

interface ModelfileEditorProps {
  models: Array<{ name: string }>;
}

interface Recommendation {
  parameter: string;
  value: string | number;
  rationale: string;
  impact: 'performance' | 'memory' | 'quality';
}

const IMPACT_STYLES: Record<string, string> = {
  performance: 'bg-forge-accent/20 text-forge-accent',
  memory: 'bg-forge-warning/20 text-forge-warning',
  quality: 'bg-forge-success/20 text-forge-success',
};

export function ModelfileEditor({ models }: ModelfileEditorProps) {
  const { generateModelfile, generateModelfileAuto, getHardware, loading } = useOllama();
  const [selectedModel, setSelectedModel] = useState('');
  const [customName, setCustomName] = useState('');
  const [useCase, setUseCase] = useState('chat');
  const [gpuVram, setGpuVram] = useState('8192');
  const [autoDetect, setAutoDetect] = useState(true);
  const [result, setResult] = useState<any>(null);
  const [hardwareInfo, setHardwareInfo] = useState<any>(null);

  const handleDetectHardware = async () => {
    const hw = await getHardware();
    if (hw) {
      setHardwareInfo(hw);
      const gpu = (hw as any).gpus?.[0];
      if (gpu) setGpuVram(String(Math.round(gpu.vramFreeMb || gpu.vramTotalMb)));
    }
  };

  const handleGenerate = async () => {
    if (!selectedModel) return;

    const config = {
      baseModel: selectedModel,
      customName: customName || `${selectedModel.split(':')[0]}-forge`,
      useCase,
    };

    let res;
    if (autoDetect) {
      res = await generateModelfileAuto(config);
    } else {
      const hardware = {
        gpuVramMb: parseInt(gpuVram, 10) || 8192,
        systemRamMb: 32768,
        gpuName: 'Unknown',
        cpuCores: 8,
        cpuPhysicalCores: 4,
        pcieGeneration: null,
        pcieBandwidthGBs: null,
      };
      res = await generateModelfile(hardware, config);
    }
    if (res) setResult(res);
  };

  return (
    <div className="space-y-6">
      <div className="bg-forge-card border border-forge-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Modelfile Generator</h2>
          <label className="flex items-center gap-2 text-sm text-forge-muted cursor-pointer">
            <input
              type="checkbox"
              checked={autoDetect}
              onChange={(e) => {
                setAutoDetect(e.target.checked);
                if (e.target.checked) handleDetectHardware();
              }}
              className="rounded"
            />
            Auto-detect hardware
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-xs text-forge-muted mb-1">Base Model</label>
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
          <div>
            <label className="block text-xs text-forge-muted mb-1">Custom Name</label>
            <input
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="my-custom-model"
              className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-forge-text"
            />
          </div>
          <div>
            <label className="block text-xs text-forge-muted mb-1">Use Case</label>
            <select
              value={useCase}
              onChange={(e) => setUseCase(e.target.value)}
              className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-forge-text"
            >
              <option value="chat">Chat</option>
              <option value="coding">Coding</option>
              <option value="analysis">Analysis</option>
              <option value="creative">Creative</option>
              <option value="agent">Agent</option>
            </select>
          </div>
          {!autoDetect && (
            <div>
              <label className="block text-xs text-forge-muted mb-1">GPU VRAM (MB)</label>
              <input
                type="number"
                value={gpuVram}
                onChange={(e) => setGpuVram(e.target.value)}
                className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-forge-text"
              />
            </div>
          )}
        </div>

        <button
          onClick={handleGenerate}
          disabled={!selectedModel || loading}
          className="px-4 py-2 bg-forge-accent text-white rounded-lg font-medium
                     hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Generating...' : 'Generate Modelfile'}
        </button>
      </div>

      {result && (
        <>
          {/* Hardware Parameters */}
          <div className="bg-forge-card border border-forge-border rounded-xl p-6">
            <h3 className="text-sm font-semibold mb-3">Optimized Parameters</h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <ParamCard label="GPU Layers" value={`${result.numGpu ?? '-'}`} sub={result.splitRatio} />
              <ParamCard label="Threads" value={`${result.numThread ?? '-'}`} sub="Physical cores" />
              <ParamCard label="Batch Size" value={`${result.numBatch ?? '-'}`} sub="Prompt eval" />
              <ParamCard label="Context" value={result.maxContextTokens?.toLocaleString() ?? '-'} sub="tokens" />
            </div>
            <div className="mt-3 flex gap-4 text-xs text-forge-muted">
              <span>Est. VRAM: <strong className="text-forge-text">{result.estimatedVramMb} MB</strong></span>
              {result.storageAdvice && <span>{result.storageAdvice}</span>}
            </div>
          </div>

          {/* Recommendations */}
          {result.recommendations?.length > 0 && (
            <div className="bg-forge-card border border-forge-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-3">Recommendations</h3>
              <div className="space-y-2">
                {result.recommendations.map((r: Recommendation, i: number) => (
                  <div key={i} className="flex items-start gap-3 text-sm">
                    <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${IMPACT_STYLES[r.impact] || ''}`}>
                      {r.impact}
                    </span>
                    <div>
                      <span className="text-forge-text font-medium">{r.parameter}</span>
                      <span className="text-forge-muted"> = {r.value}</span>
                      <div className="text-xs text-forge-muted mt-0.5">{r.rationale}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Generated Modelfile */}
          <div className="bg-forge-card border border-forge-border rounded-xl p-6">
            <h3 className="text-sm font-semibold mb-3">Generated Modelfile</h3>
            <pre className="bg-forge-bg border border-forge-border rounded-lg p-4 text-sm text-forge-text overflow-x-auto whitespace-pre-wrap font-mono">
              {result.content}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}

function ParamCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-forge-bg rounded-lg p-3">
      <div className="text-xs text-forge-muted">{label}</div>
      <div className="text-xl font-bold text-forge-text">{value}</div>
      <div className="text-xs text-forge-muted truncate">{sub}</div>
    </div>
  );
}
