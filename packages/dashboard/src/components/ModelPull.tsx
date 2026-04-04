import React, { useState } from 'react';

interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export function ModelPull({ onComplete }: { onComplete?: () => void }) {
  const [modelName, setModelName] = useState('');
  const [pulling, setPulling] = useState(false);
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePull = async () => {
    if (!modelName.trim() || pulling) return;
    setPulling(true);
    setError(null);
    setProgress({ status: 'Starting pull...' });

    try {
      const response = await fetch('/api/models/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName.trim() }),
      });

      if (!response.ok || !response.body) {
        setError(`Pull failed: HTTP ${response.status}`);
        setPulling(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const match = line.match(/^data:\s*(.+)/);
          if (!match) continue;
          try {
            const event: PullProgress = JSON.parse(match[1]);
            setProgress(event);
            if (event.status === 'success') {
              setModelName('');
              onComplete?.();
            } else if (event.status === 'error') {
              setError((event as any).error || 'Pull failed');
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setPulling(false);
      setTimeout(() => setProgress(null), 2000);
    }
  };

  const pct = progress?.total && progress?.completed
    ? Math.round((progress.completed / progress.total) * 100)
    : null;

  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-4">
      <h3 className="text-sm font-semibold mb-3">Pull Model</h3>
      <div className="flex gap-2">
        <input
          type="text"
          value={modelName}
          onChange={(e) => setModelName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handlePull()}
          placeholder="e.g. phi4:14b, mistral-small:24b"
          disabled={pulling}
          className="flex-1 bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-sm text-forge-text disabled:opacity-50"
        />
        <button
          onClick={handlePull}
          disabled={!modelName.trim() || pulling}
          className="px-4 py-2 bg-forge-accent text-white rounded-lg text-sm font-medium hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {pulling ? 'Pulling...' : 'Pull'}
        </button>
      </div>

      {progress && (
        <div className="mt-3">
          <div className="text-xs text-forge-muted mb-1">{progress.status}</div>
          {pct !== null && (
            <div className="w-full bg-forge-border rounded-full h-2">
              <div
                className="bg-forge-accent rounded-full h-2 transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          {pct !== null && (
            <div className="text-xs text-forge-muted mt-1 text-right">{pct}%</div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-2 text-xs text-forge-danger">{error}</div>
      )}
    </div>
  );
}
