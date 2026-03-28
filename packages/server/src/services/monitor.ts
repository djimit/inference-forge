/**
 * Monitor Service
 * Polls Ollama at regular intervals and emits metrics via callback.
 */

import { ollama, type RunningModel, type OllamaModel } from './ollama.js';

export interface SystemMetrics {
  timestamp: number;
  ollamaOnline: boolean;
  models: {
    available: OllamaModel[];
    running: RunningModel[];
  };
  vram: {
    totalUsed: number;      // bytes used by all running models
    perModel: Array<{
      name: string;
      sizeVram: number;     // bytes in VRAM
      sizeTotal: number;    // total model size
      parameterSize: string;
      quantization: string;
    }>;
  };
  kvCache: {
    // Estimated from model config and context size
    estimatedPerModel: Array<{
      name: string;
      estimatedKvBytes: number;
      kvCacheType: string;  // f16, q8_0, q4_0
      numCtx: number;
    }>;
  };
}

type MetricsCallback = (metrics: SystemMetrics) => void;

export class MonitorService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private listeners: Set<MetricsCallback> = new Set();
  private lastMetrics: SystemMetrics | null = null;
  private pollIntervalMs: number;

  constructor(pollIntervalMs = 1000) {
    this.pollIntervalMs = pollIntervalMs;
  }

  /** Subscribe to metrics updates */
  subscribe(callback: MetricsCallback): () => void {
    this.listeners.add(callback);
    // Send last known metrics immediately
    if (this.lastMetrics) {
      callback(this.lastMetrics);
    }
    return () => this.listeners.delete(callback);
  }

  /** Start polling */
  start(): void {
    if (this.intervalId) return;
    this.poll(); // immediate first poll
    this.intervalId = setInterval(() => this.poll(), this.pollIntervalMs);
    console.log(`[Monitor] Polling Ollama every ${this.pollIntervalMs}ms`);
  }

  /** Stop polling */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Monitor] Stopped polling');
    }
  }

  /** Get last known metrics */
  getLastMetrics(): SystemMetrics | null {
    return this.lastMetrics;
  }

  private async poll(): Promise<void> {
    try {
      const online = await ollama.ping();
      if (!online) {
        const metrics: SystemMetrics = {
          timestamp: Date.now(),
          ollamaOnline: false,
          models: { available: [], running: [] },
          vram: { totalUsed: 0, perModel: [] },
          kvCache: { estimatedPerModel: [] },
        };
        this.emit(metrics);
        return;
      }

      const [available, running] = await Promise.all([
        ollama.listModels(),
        ollama.listRunning(),
      ]);

      const vramPerModel = running.map((m) => ({
        name: m.name,
        sizeVram: m.size_vram,
        sizeTotal: m.size,
        parameterSize: m.details.parameter_size,
        quantization: m.details.quantization_level,
      }));

      const totalVram = vramPerModel.reduce((sum, m) => sum + m.sizeVram, 0);

      // KV cache estimation: rough heuristic based on model architecture
      // Real values would need model-specific arch info
      const kvEstimates = running.map((m) => ({
        name: m.name,
        estimatedKvBytes: this.estimateKvCache(m),
        kvCacheType: process.env.OLLAMA_KV_CACHE_TYPE || 'f16',
        numCtx: 2048, // default, would be extracted from modelfile
      }));

      const metrics: SystemMetrics = {
        timestamp: Date.now(),
        ollamaOnline: true,
        models: { available, running },
        vram: { totalUsed: totalVram, perModel: vramPerModel },
        kvCache: { estimatedPerModel: kvEstimates },
      };

      this.emit(metrics);
    } catch (err) {
      console.error('[Monitor] Poll error:', err);
    }
  }

  /**
   * Rough KV cache size estimation.
   * KV cache ≈ 2 * num_layers * num_heads * head_dim * num_ctx * bytes_per_element
   * Without model arch details, we estimate from total model size.
   */
  private estimateKvCache(model: RunningModel): number {
    const paramStr = model.details.parameter_size; // e.g. "7B", "13B"
    const paramBillions = parseFloat(paramStr) || 7;

    // Heuristic: KV cache at f16, 2048 ctx ≈ ~0.5GB per 7B params
    const kvCacheType = process.env.OLLAMA_KV_CACHE_TYPE || 'f16';
    const baseKvBytes = (paramBillions / 7) * 512 * 1024 * 1024; // 512MB baseline

    const multiplier: Record<string, number> = {
      f16: 1.0,
      q8_0: 0.5,
      q4_0: 0.25,
    };

    return baseKvBytes * (multiplier[kvCacheType] ?? 1.0);
  }

  private emit(metrics: SystemMetrics): void {
    this.lastMetrics = metrics;
    for (const cb of this.listeners) {
      try {
        cb(metrics);
      } catch (err) {
        console.error('[Monitor] Listener error:', err);
      }
    }
  }
}

export const monitor = new MonitorService();
