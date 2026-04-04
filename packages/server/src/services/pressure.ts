/**
 * Resource Pressure Prediction Service
 * Tracks VRAM allocation, predicts OOM risk, and advises on concurrent model capacity.
 * Informed by flash-moe's memory budgeting methodology.
 */

import { monitor, type SystemMetrics } from './monitor.js';
import { hardware, type HardwareSnapshot } from './hardware.js';
import { ollama } from './ollama.js';

// -- Types ----------------------------------------------------------

export interface LoadedModelInfo {
  name: string;
  vramUsageMb: number;
  parameterSize: string;
  quantization: string;
}

export interface ModelCapacityPrediction {
  modelName: string;
  estimatedVramMb: number;
  fitsInFreeVram: boolean;
  wouldEvict: string[];
  recommendedAction: string;
}

export interface ResourcePressure {
  timestamp: number;
  vramUsedMb: number;
  vramTotalMb: number;
  vramFreePercent: number;
  ramUsedMb: number;
  ramTotalMb: number;
  loadedModels: LoadedModelInfo[];
  concurrentModelLimit: number;
  pressureLevel: 'low' | 'moderate' | 'high' | 'critical';
  advice: string;
}

// -- Service --------------------------------------------------------

export class PressureService {
  private lastPressure: ResourcePressure | null = null;
  private listeners: Set<(pressure: ResourcePressure) => void> = new Set();

  start(): void {
    // React to monitor updates
    monitor.subscribe((metrics: SystemMetrics) => {
      const hwSnapshot = hardware.getLastSnapshot();
      if (hwSnapshot) {
        this.evaluate(metrics, hwSnapshot);
      }
    });
  }

  subscribe(callback: (pressure: ResourcePressure) => void): () => void {
    this.listeners.add(callback);
    if (this.lastPressure) callback(this.lastPressure);
    return () => this.listeners.delete(callback);
  }

  getLastPressure(): ResourcePressure | null {
    return this.lastPressure;
  }

  async predictLoadImpact(modelName: string): Promise<ModelCapacityPrediction> {
    const hwSnapshot = hardware.getLastSnapshot();
    const vramTotalMb = hwSnapshot?.totalGpuVramMb || 0;
    const vramUsedMb = hwSnapshot?.totalGpuVramUsedMb || 0;
    const vramFreeMb = vramTotalMb - vramUsedMb;

    // Estimate model VRAM from Ollama
    let estimatedVramMb = 0;
    try {
      const info = await ollama.showModel(modelName);
      const match = info.details?.parameter_size?.match(/([\d.]+)\s*B/i);
      if (match) {
        const billions = parseFloat(match[1]);
        const quantLevel = info.details?.quantization_level?.toLowerCase() || '';
        const bytesPerParam = quantLevel.includes('q4') ? 0.5
          : quantLevel.includes('q8') ? 1.0
          : quantLevel.includes('f16') ? 2.0
          : 0.5;
        estimatedVramMb = Math.round(billions * 1000 * bytesPerParam);
      }
    } catch {
      estimatedVramMb = 4096; // default 4GB estimate
    }

    // Check if model fits entirely in VRAM, partially, or needs full CPU/RAM inference
    const fitsInFreeVram = estimatedVramMb <= vramFreeMb;
    const ramFreeMb = (hwSnapshot?.system?.ramFreeMb || 0);
    const ramTotalMb = (hwSnapshot?.system?.ramTotalMb || 0);

    // Determine which models would be evicted (oldest first by Ollama's LRU)
    const wouldEvict: string[] = [];
    if (!fitsInFreeVram && this.lastPressure) {
      let reclaimNeeded = estimatedVramMb - vramFreeMb;
      const sorted = [...this.lastPressure.loadedModels].sort((a, b) => a.vramUsageMb - b.vramUsageMb);
      for (const model of sorted) {
        if (reclaimNeeded <= 0) break;
        wouldEvict.push(model.name);
        reclaimNeeded -= model.vramUsageMb;
      }
    }

    // Smart recommendation: account for CPU/RAM fallback (Ollama splits across GPU+RAM automatically)
    let recommendedAction: string;
    if (fitsInFreeVram) {
      recommendedAction = `Safe to load fully in GPU. ${Math.round(vramFreeMb - estimatedVramMb)}MB VRAM will remain free.`;
    } else if (estimatedVramMb <= vramTotalMb) {
      // Fits in total VRAM but needs eviction
      recommendedAction = wouldEvict.length > 0
        ? `Loading will evict: ${wouldEvict.join(', ')}. Consider unloading models first.`
        : `Insufficient free VRAM. Need ${estimatedVramMb}MB, only ${Math.round(vramFreeMb)}MB free.`;
    } else if (estimatedVramMb <= ramFreeMb + vramFreeMb) {
      // Model exceeds total VRAM — will run as GPU+CPU split or CPU-only
      const gpuLayersPct = vramTotalMb > 0 ? Math.round((vramFreeMb / estimatedVramMb) * 100) : 0;
      const ramNeededMb = estimatedVramMb - vramFreeMb;
      recommendedAction = `Model exceeds ${vramTotalMb}MB total VRAM — will use split inference: ~${gpuLayersPct}% GPU + ${Math.round(ramNeededMb)}MB system RAM. Expect slower tok/s from CPU layers.`;
    } else {
      recommendedAction = `Model needs ${estimatedVramMb}MB but only ${Math.round(vramFreeMb)}MB VRAM + ${Math.round(ramFreeMb)}MB free RAM available. May cause swapping.`;
    }

    return {
      modelName,
      estimatedVramMb,
      fitsInFreeVram,
      wouldEvict,
      recommendedAction,
    };
  }

  private evaluate(metrics: SystemMetrics, hw: HardwareSnapshot): void {
    const vramTotalMb = hw.totalGpuVramMb;
    const vramUsedMb = hw.totalGpuVramUsedMb;
    const vramFreePercent = vramTotalMb > 0 ? ((vramTotalMb - vramUsedMb) / vramTotalMb) * 100 : 100;

    const loadedModels: LoadedModelInfo[] = (metrics.models?.running || []).map((m: any) => ({
      name: m.name,
      vramUsageMb: Math.round((m.size_vram || 0) / (1024 * 1024)),
      parameterSize: m.details?.parameter_size || 'unknown',
      quantization: m.details?.quantization_level || 'unknown',
    }));

    // Estimate how many average-sized models can fit
    const avgModelVramMb = loadedModels.length > 0
      ? loadedModels.reduce((s, m) => s + m.vramUsageMb, 0) / loadedModels.length
      : 4096;
    const freeMb = vramTotalMb - vramUsedMb;
    const concurrentModelLimit = loadedModels.length + Math.max(0, Math.floor(freeMb / avgModelVramMb));

    // Determine pressure level
    const usedPercent = vramTotalMb > 0 ? (vramUsedMb / vramTotalMb) * 100 : 0;
    let pressureLevel: ResourcePressure['pressureLevel'];
    let advice: string;

    if (usedPercent >= 95) {
      pressureLevel = 'critical';
      advice = 'VRAM nearly full. Loading another model will cause eviction. Consider unloading unused models.';
    } else if (usedPercent >= 80) {
      pressureLevel = 'high';
      advice = `${Math.round(freeMb)}MB VRAM free. Only small models can be loaded without eviction.`;
    } else if (usedPercent >= 50) {
      pressureLevel = 'moderate';
      advice = `${Math.round(freeMb)}MB VRAM free. Can load ~${Math.floor(freeMb / avgModelVramMb)} more model(s) of similar size.`;
    } else {
      pressureLevel = 'low';
      advice = `Plenty of VRAM available. ${Math.round(freeMb)}MB free.`;
    }

    const pressure: ResourcePressure = {
      timestamp: Date.now(),
      vramUsedMb: Math.round(vramUsedMb),
      vramTotalMb: Math.round(vramTotalMb),
      vramFreePercent: Math.round(vramFreePercent * 10) / 10,
      ramUsedMb: hw.system.ramUsedMb,
      ramTotalMb: hw.system.ramTotalMb,
      loadedModels,
      concurrentModelLimit,
      pressureLevel,
      advice,
    };

    this.lastPressure = pressure;
    for (const cb of this.listeners) {
      try { cb(pressure); } catch {}
    }
  }
}

export const pressure = new PressureService();
