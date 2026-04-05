import React, { useState, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useOllama } from '../hooks/useOllama';
import { VramGauge } from './VramGauge';
import { ModelList } from './ModelList';
import { KvCachePanel } from './KvCachePanel';
import { MetricsChart } from './MetricsChart';
import { BenchmarkRunner } from './BenchmarkRunner';
import { ModelfileEditor } from './ModelfileEditor';
import { PressurePanel } from './PressurePanel';
import { IoProfilePanel } from './IoProfilePanel';
import { AlertsPanel } from './AlertsPanel';
import { ThroughputChart } from './ThroughputChart';
import { HardwarePanel } from './HardwarePanel';
import { TemplateGallery } from './TemplateGallery';
import { AgentPanel } from './AgentPanel';
import { ModelPull } from './ModelPull';
import { BackendPanel } from './BackendPanel';

type Tab = 'monitor' | 'benchmark' | 'modelfile' | 'analysis' | 'agents';

export function Dashboard() {
  const wsUrl = `ws://${window.location.hostname}:3001/ws`;
  const {
    metrics, connected,
    hardwareData, alertsData, throughputData,
    pressureData, benchmarkProgress,
  } = useWebSocket(wsUrl);
  const { apiCall } = useOllama();
  const [activeTab, setActiveTab] = useState<Tab>('monitor');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'monitor', label: 'Monitor' },
    { id: 'benchmark', label: 'Benchmark' },
    { id: 'modelfile', label: 'Modelfile' },
    { id: 'analysis', label: 'Analysis' },
    { id: 'agents', label: 'Agents' },
  ];

  const handleAcknowledge = useCallback(async (id: string) => {
    await apiCall(`/alerts/${id}/acknowledge`, { method: 'POST' });
  }, [apiCall]);

  const handleAcknowledgeAll = useCallback(async () => {
    await apiCall('/alerts/acknowledge-all', { method: 'POST' });
  }, [apiCall]);

  return (
    <div className="min-h-screen bg-forge-bg">
      {/* Header */}
      <header className="border-b border-forge-border bg-forge-card">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-2xl font-bold">
              <span className="text-forge-accent">Inference</span>{' '}
              <span className="text-forge-text">Forge</span>
            </div>
            <span className="text-xs bg-forge-accent/20 text-forge-accent px-2 py-0.5 rounded-full">
              v0.2.0
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
              <ThroughputChart throughput={throughputData} />
              <ModelList
                available={metrics?.models?.available || []}
                running={metrics?.models?.running || []}
              />
              <ModelPull />
            </div>
            <div className="space-y-6">
              <VramGauge
                totalUsed={metrics?.vram?.totalUsed || 0}
                perModel={metrics?.vram?.perModel || []}
              />
              <HardwarePanel hardware={hardwareData} />
              <KvCachePanel
                estimates={metrics?.kvCache?.estimatedPerModel || []}
              />
              <PressurePanel
                pressure={pressureData}
                models={metrics?.models?.available}
              />
              <AlertsPanel
                alerts={alertsData}
                onAcknowledge={handleAcknowledge}
                onAcknowledgeAll={handleAcknowledgeAll}
              />
            </div>
          </div>
        )}

        {activeTab === 'benchmark' && (
          <BenchmarkRunner
            models={metrics?.models?.available || []}
            benchmarkProgress={benchmarkProgress}
          />
        )}

        {activeTab === 'modelfile' && (
          <div className="space-y-6">
            <ModelfileEditor models={metrics?.models?.available || []} />
            <TemplateGallery />
          </div>
        )}

        {activeTab === 'analysis' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <IoProfilePanel />
            <BackendPanel />
          </div>
        )}

        {activeTab === 'agents' && (
          <AgentPanel models={metrics?.models?.available || []} />
        )}
      </main>
    </div>
  );
}
