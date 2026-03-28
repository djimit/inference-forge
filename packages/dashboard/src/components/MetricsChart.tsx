import React, { useState, useEffect, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface MetricsChartProps {
  metrics: any;
}

interface DataPoint {
  time: string;
  timestamp: number;
  totalVramGb: number;
  modelCount: number;
}

const MAX_POINTS = 60; // 60 seconds of history at 1s intervals

export function MetricsChart({ metrics }: MetricsChartProps) {
  const [history, setHistory] = useState<DataPoint[]>([]);
  const lastTimestamp = useRef(0);

  useEffect(() => {
    if (!metrics || metrics.timestamp === lastTimestamp.current) return;
    lastTimestamp.current = metrics.timestamp;

    const point: DataPoint = {
      time: new Date(metrics.timestamp).toLocaleTimeString(),
      timestamp: metrics.timestamp,
      totalVramGb: metrics.vram.totalUsed / (1024 * 1024 * 1024),
      modelCount: metrics.models.running.length,
    };

    setHistory((prev) => {
      const updated = [...prev, point];
      return updated.slice(-MAX_POINTS);
    });
  }, [metrics]);

  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-4">VRAM Over Time</h2>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={history}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
          <XAxis
            dataKey="time"
            stroke="#94a3b8"
            tick={{ fontSize: 11 }}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke="#94a3b8"
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => `${v.toFixed(1)}G`}
          />
          <Tooltip
            contentStyle={{
              background: '#1a1d2e',
              border: '1px solid #2a2d3e',
              borderRadius: '8px',
            }}
            labelStyle={{ color: '#94a3b8' }}
          />
          <Legend />
          <Line
            type="monotone"
            dataKey="totalVramGb"
            name="VRAM (GB)"
            stroke="#6366f1"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
