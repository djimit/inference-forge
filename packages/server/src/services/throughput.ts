/**
 * Throughput Tracker
 * Tracks per-model token throughput over time with rolling window history.
 */

export interface ThroughputSample {
  timestamp: number;
  model: string;
  tokensPerSecond: number;
  promptEvalTps: number;
  evalTps: number;
  totalTokens: number;
  latencyMs: number;
}

export interface ModelThroughputHistory {
  model: string;
  samples: ThroughputSample[];
  avgTokensPerSecond: number;
  peakTokensPerSecond: number;
  minTokensPerSecond: number;
  totalRequests: number;
  totalTokens: number;
}

export interface ThroughputSnapshot {
  timestamp: number;
  models: Record<string, ModelThroughputHistory>;
  globalAvgTps: number;
  globalTotalRequests: number;
}

const MAX_SAMPLES_PER_MODEL = 500; // 8 minutes at 1 sample/sec

export class ThroughputTracker {
  private history: Record<string, ThroughputSample[]> = {};
  private listeners: Set<(snapshot: ThroughputSnapshot) => void> = new Set();

  /**
   * Record a throughput sample from a generation response.
   */
  record(sample: ThroughputSample): void {
    if (!this.history[sample.model]) {
      this.history[sample.model] = [];
    }

    const modelHistory = this.history[sample.model];
    modelHistory.push(sample);

    // Trim to max window
    if (modelHistory.length > MAX_SAMPLES_PER_MODEL) {
      modelHistory.splice(0, modelHistory.length - MAX_SAMPLES_PER_MODEL);
    }

    this.emit();
  }

  /**
   * Record from an Ollama generate response (durations in nanoseconds).
   */
  recordFromResponse(model: string, response: {
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    eval_count?: number;
    eval_duration?: number;
    total_duration?: number;
  }): void {
    const promptEvalMs = (response.prompt_eval_duration || 0) / 1_000_000;
    const evalMs = (response.eval_duration || 0) / 1_000_000;
    const totalMs = (response.total_duration || 0) / 1_000_000;
    const evalCount = response.eval_count || 0;
    const promptEvalCount = response.prompt_eval_count || 0;

    const evalTps = evalMs > 0 ? (evalCount / evalMs) * 1000 : 0;
    const promptEvalTps = promptEvalMs > 0 ? (promptEvalCount / promptEvalMs) * 1000 : 0;

    this.record({
      timestamp: Date.now(),
      model,
      tokensPerSecond: evalTps,
      promptEvalTps,
      evalTps,
      totalTokens: evalCount + promptEvalCount,
      latencyMs: totalMs,
    });
  }

  /**
   * Get throughput history for all models.
   */
  getSnapshot(): ThroughputSnapshot {
    const models: Record<string, ModelThroughputHistory> = {};
    let globalTotalTps = 0;
    let globalTotalRequests = 0;

    for (const [model, samples] of Object.entries(this.history)) {
      if (samples.length === 0) continue;

      const tpsValues = samples.map((s) => s.tokensPerSecond).filter((v) => v > 0);
      const avgTps = tpsValues.length > 0
        ? tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length
        : 0;

      models[model] = {
        model,
        samples: samples.slice(-60), // last 60 samples for charts
        avgTokensPerSecond: Math.round(avgTps * 100) / 100,
        peakTokensPerSecond: Math.round(Math.max(...tpsValues, 0) * 100) / 100,
        minTokensPerSecond: Math.round(Math.min(...tpsValues, 0) * 100) / 100,
        totalRequests: samples.length,
        totalTokens: samples.reduce((sum, s) => sum + s.totalTokens, 0),
      };

      globalTotalTps += avgTps;
      globalTotalRequests += samples.length;
    }

    return {
      timestamp: Date.now(),
      models,
      globalAvgTps: Math.round(globalTotalTps * 100) / 100,
      globalTotalRequests,
    };
  }

  /**
   * Get history for a specific model.
   */
  getModelHistory(model: string): ThroughputSample[] {
    return this.history[model] || [];
  }

  subscribe(callback: (snapshot: ThroughputSnapshot) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  clear(model?: string): void {
    if (model) {
      delete this.history[model];
    } else {
      this.history = {};
    }
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const cb of this.listeners) {
      try { cb(snapshot); } catch {}
    }
  }
}

export const throughput = new ThroughputTracker();
