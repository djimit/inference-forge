import React, { useState } from 'react';

interface Alert {
  id: string;
  timestamp: number;
  severity: 'info' | 'warning' | 'critical';
  category: string;
  title: string;
  message: string;
  acknowledged: boolean;
}

interface AlertsPanelProps {
  alerts: Alert[];
  onAcknowledge: (id: string) => void;
  onAcknowledgeAll: () => void;
}

const severityStyles: Record<string, string> = {
  info: 'border-forge-accent bg-forge-accent/10 text-forge-accent',
  warning: 'border-forge-warning bg-forge-warning/10 text-forge-warning',
  critical: 'border-forge-danger bg-forge-danger/10 text-forge-danger',
};

export function AlertsPanel({ alerts, onAcknowledge, onAcknowledgeAll }: AlertsPanelProps) {
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const filtered = showAcknowledged ? alerts : alerts.filter((a) => !a.acknowledged);
  const unacknowledgedCount = alerts.filter((a) => !a.acknowledged).length;

  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">
          Alerts
          {unacknowledgedCount > 0 && (
            <span className="ml-2 text-xs bg-forge-danger text-white px-2 py-0.5 rounded-full">
              {unacknowledgedCount}
            </span>
          )}
        </h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAcknowledged(!showAcknowledged)}
            className="text-xs text-forge-muted hover:text-forge-text transition-colors"
          >
            {showAcknowledged ? 'Hide acknowledged' : 'Show all'}
          </button>
          {unacknowledgedCount > 0 && (
            <button
              onClick={onAcknowledgeAll}
              className="text-xs text-forge-accent hover:text-indigo-400 transition-colors"
            >
              Acknowledge all
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {filtered.map((alert) => (
          <div
            key={alert.id}
            className={`border-l-2 rounded-r-lg p-3 ${severityStyles[alert.severity]} ${
              alert.acknowledged ? 'opacity-50' : ''
            }`}
          >
            <div className="flex justify-between items-start">
              <div>
                <div className="text-sm font-medium">{alert.title}</div>
                <div className="text-xs mt-0.5 opacity-80">{alert.message}</div>
                <div className="text-xs mt-1 opacity-60">
                  {new Date(alert.timestamp).toLocaleTimeString()}
                </div>
              </div>
              {!alert.acknowledged && (
                <button
                  onClick={() => onAcknowledge(alert.id)}
                  className="text-xs opacity-60 hover:opacity-100 transition-opacity ml-2 shrink-0"
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="text-forge-muted text-sm text-center py-4">No alerts</p>
        )}
      </div>
    </div>
  );
}
