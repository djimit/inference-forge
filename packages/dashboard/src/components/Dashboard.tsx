import React, { useState } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { VramGauge } from './VramGauge';
import { ModelList } from './ModelList';
import { KvCachePanel } from './KvCachePanel';
import { MetricsChart } from './MetricsChart';
import { BenchmarkRunner } from './BenchmarkRunner';
import { ModelfileEditor } from './ModelfileEditor';

type Tab = 'monitor' | 'benchmark' | 'modelfile';

export function Dashboard() {
  const wsUrl = `ws://${window.location.hostname}:3001/ws`;
  const { metrics, connected } = useWebSocket(wsUrl);
  const [activeTab, setActiveTab] = useState<Tab>('monitor');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'monitor', label: 'Monitor' },
    { id: 'benchmark', label: 'Benchmark' },
    { id: 'modelfile', label: 'Modelfile' },
  ];

  return (
    <div className="min-h-screen bg-forge-bg">
      {/* Header */}
      <header className="border-b border-forge-border bg-forge-card">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-2xl font-bold">
              <span className="text-forge-accent">Ollama</span>{' '}
              <span className="text-forge-text">Forge</span>
            </div>
            <span className="text-xs bg-forge-accent/20 text-forge-accent px-2 py-0.5 rounded-full">
              v0.1.0
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                connected && metrics?.ollamaOnline
                  ? 'bg-forge-success'
                  : connected
                  ? 'bg-forge-warning'
                  : 'bg-forge-danger'
              }`}
            />
            <span className="text-sm text-forge-muted">
              {connected && metrics?.ollamaOnline
                ? 'Ollama Connected'
                : connected
                ? 'Ollama Offline'
                : 'Connecting...'}
            </span>
          </div>
        </div>
      </header>

      {/* Tab Navigation */}
      <nav className="max-w-7xl mx-auto px-6 pt-4">
        <div className="flex gap-1 bg-forge-card border border-forge-border rounded-lg p-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-forge-accent text-white'
                  : 'text-forge-muted hover:text-forge-text hover:bg-forge-bg'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-6 py-6">
        {activeTab === 'monitor' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <MetricsChart metrics={metrics} />
              <ModelList
                available={metrics?.models?.available || []}
                running={metrics?.models?.running || []}
              />
            </div>
            <div className="space-y-6">
              <VramGauge
                totalUsed={metrics?.vram?.totalUsed || 0}
                perModel={metrics?.vram?.perModel || []}
              />
              <KvCachePanel
                estimates={metrics?.kvCache?.estimatedPerModel || []}
              />
            </div>
          </div>
        )}

        {activeTab === 'benchmark' && (
          <BenchmarkRunner models={metrics?.models?.available || []} />
        )}

        {activeTab === 'modelfile' && (
          <ModelfileEditor models={metrics?.models?.available || []} />
        )}
      </main>
    </div>
  );
}
