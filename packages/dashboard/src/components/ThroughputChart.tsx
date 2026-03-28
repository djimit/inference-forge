import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, BarChart, Bar,
} from 'recharts';

interface ThroughputChartProps {
  throughput: {
    models: Record<string, {
      model: string;
      samples: Array<{ timestamp: number; tokensPerSecond: number }>;
      avgTokensPerSecond: number;
      peakTokensPerSecond: number;
      totalRequests: number;
    }>;
    globalAvgTps: number;
  } | null;
}

const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

export function ThroughputChart({ throughput: tp }: ThroughputChartProps) {
  if (!tp || Object.keys(tp.models).length === 0) {
    return (
      <div className="bg-forge-card border border-forge-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-2">Throughput</h2>
        <p className="text-forge-muted text-sm">No throughput data yet. Run a generation to start tracking.</p>
      </div>
    );
  }

  const models = Object.values(tp.models);

  // Build comparison data for bar chart
  const comparisonData = models.map((m) => ({
    name: m.model.split(':')[0],
    avg: m.avgTokensPerSecond,
    peak: m.peakTokensPerSecond,
  }));

  // Build time-series from first model with samples
  const primaryModel = models.find((m) => m.samples.length > 0);
  const timeData = primaryModel?.samples.map((s) => ({
    time: new Date(s.timestamp).toLocaleTimeString(),
    tps: Math.round(s.tokensPerSecond * 100) / 100,
  })) || [];

  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Throughput</h2>
        <span className="text-sm text-forge-muted">
          Global avg: <strong className="text-forge-accent">{tp.globalAvgTps} tok/s</strong>
        </span>
      </div>

      {/* Model comparison */}
      {comparisonData.length > 1 && (
        <div className="mb-6">
          <h3 className="text-sm text-forge-muted mb-2">Model Comparison</h3>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={comparisonData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
              <XAxis dataKey="name" stroke="#94a3b8" tick={{ fontSize: 11 }} />
              <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#1a1d2e', border: '1px solid #2a2d3e', borderRadius: '8px' }}
              />
              <Bar dataKey="avg" name="Avg tok/s" fill="#6366f1" radius={[4, 4, 0, 0]} />
              <Bar dataKey="peak" name="Peak tok/s" fill="#22c55e" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Time series */}
      {timeData.length > 0 && (
        <div>
          <h3 className="text-sm text-forge-muted mb-2">
            {primaryModel?.model} — tokens/sec over time
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={timeData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
              <XAxis dataKey="time" stroke="#94a3b8" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#1a1d2e', border: '1px solid #2a2d3e', borderRadius: '8px' }}
              />
              <Line type="monotone" dataKey="tps" name="tok/s" stroke="#6366f1" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
