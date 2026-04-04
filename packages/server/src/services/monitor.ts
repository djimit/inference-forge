/**
 * Monitor Service
 * Polls Ollama at regular intervals and emits metrics via callback.
 */

import { ollama, parseModelArch, type RunningModel, type OllamaModel } from './ollama.js';

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
  private contextCache: Map<string, number> = new Map();

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

      // Resolve actual context length per running model (cached)
      const kvEstimates = await Promise.all(running.map(async (m) => {
        const numCtx = await this.resolveContextLength(m.name);
        return {
          name: m.name,
          estimatedKvBytes: this.estimateKvCache(m, numCtx),
          kvCacheType: process.env.OLLAMA_KV_CACHE_TYPE || 'f16',
          numCtx,
        };
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
   * Resolve actual context length from Ollama model info.
   * Caches results to avoid repeated /api/show calls.
   */
  private async resolveContextLength(modelName: string): Promise<number> {
    if (this.contextCache.has(modelName)) {
      return this.contextCache.get(modelName)!;
    }
    try {
      const info = await ollama.showModel(modelName);
      const arch = parseModelArch(info);
      let numCtx = arch?.contextLength || 0;

      // Check modelfile parameters for num_ctx override
      if (info.parameters) {
        const match = info.parameters.match(/num_ctx\s+(\d+)/);
        if (match) numCtx = parseInt(match[1], 10);
      }

      if (!numCtx) numCtx = 2048; // fallback
      this.contextCache.set(modelName, numCtx);
      return numCtx;
    } catch {
      return 2048;
    }
  }

  /**
   * KV cache size estimation scaled by actual context length.
   * KV ≈ 2 * layers * heads_kv * head_dim * num_ctx * bytes_per_element
   * Heuristic fallback: ~0.5GB per 7B params at f16 / 2048 ctx.
   */
  private estimateKvCache(model: RunningModel, numCtx: number): number {
    const paramStr = model.details.parameter_size;
    const paramBillions = parseFloat(paramStr) || 7;

    // Scale baseline (512MB for 7B at 2048 ctx) by actual context
    const kvCacheType = process.env.OLLAMA_KV_CACHE_TYPE || 'f16';
    const ctxScale = numCtx / 2048;
    const baseKvBytes = (paramBillions / 7) * 512 * 1024 * 1024 * ctxScale;

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
