import React, { useState } from 'react';
import { useOllama } from '../hooks/useOllama';

interface ModelfileEditorProps {
  models: Array<{ name: string }>;
}

export function ModelfileEditor({ models }: ModelfileEditorProps) {
  const { generateModelfile, loading } = useOllama();
  const [selectedModel, setSelectedModel] = useState('');
  const [customName, setCustomName] = useState('');
  const [useCase, setUseCase] = useState('chat');
  const [gpuVram, setGpuVram] = useState('8192');
  const [result, setResult] = useState<any>(null);

  const handleGenerate = async () => {
    if (!selectedModel) return;

    const hardware = {
      gpuVramMb: parseInt(gpuVram, 10) || 8192,
      systemRamMb: 32768, // default, could be detected
      gpuName: 'Unknown',
      cpuCores: 8,
    };

    const config = {
      baseModel: selectedModel,
      customName: customName || `${selectedModel.split(':')[0]}-forge`,
      useCase,
    };

    const res = await generateModelfile(hardware, config);
    if (res) setResult(res);
  };

  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-4">Modelfile Generator</h2>

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
        <div>
          <label className="block text-xs text-forge-muted mb-1">GPU VRAM (MB)</label>
          <input
            type="number"
            value={gpuVram}
            onChange={(e) => setGpuVram(e.target.value)}
            className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-forge-text"
          />
        </div>
      </div>

      <button
        onClick={handleGenerate}
        disabled={!selectedModel || loading}
        className="px-4 py-2 bg-forge-accent text-white rounded-lg font-medium
                   hover:bg-indigo-500 disabled:opacity-50 transition-colors"
      >
        Generate Modelfile
      </button>

      {result && (
        <div className="mt-4">
          <div className="flex gap-3 mb-3 text-sm">
            <span className="text-forge-muted">
              Est. VRAM: <strong className="text-forge-text">{result.estimatedVramMb} MB</strong>
            </span>
            <span className="text-forge-muted">
              Context: <strong className="text-forge-text">{result.maxContextTokens?.toLocaleString()} tokens</strong>
            </span>
          </div>

          {result.recommendations?.length > 0 && (
            <div className="mb-3 p-3 bg-forge-bg rounded-lg text-xs text-forge-muted space-y-1">
              {result.recommendations.map((r: string, i: number) => (
                <div key={i}>{r}</div>
              ))}
            </div>
          )}

          <pre className="bg-forge-bg border border-forge-border rounded-lg p-4 text-sm text-forge-text overflow-x-auto whitespace-pre-wrap font-mono">
            {result.content}
          </pre>
        </div>
      )}
    </div>
  );
}
