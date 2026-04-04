/**
 * Smart Modelfile Generator
 * Generates optimized Ollama Modelfiles based on hardware specs and model characteristics.
 * Enhanced with flash-moe methodology: hardware-aware GPU offload, thread count, batch size.
 */

import { ollama, parseModelArch, type ModelInfo, type ModelArchInfo } from './ollama.js';

// -- Types ----------------------------------------------------------

export interface HardwareProfile {
  gpuVramMb: number;
  systemRamMb: number;
  gpuName: string;
  cpuCores: number;
  cpuPhysicalCores: number;
  numaNodes?: number;
  coresPerNuma?: number;
  pcieGeneration: number | null;
  pcieBandwidthGBs: number | null;
}

export interface ModelfileConfig {
  baseModel: string;
  customName: string;
  useCase: 'chat' | 'coding' | 'analysis' | 'creative' | 'agent';
  maxContextTokens?: number;
  kvCacheType?: string;
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  numGpu?: number;
  numThread?: number;
  numBatch?: number;
}

export interface Recommendation {
  parameter: string;
  value: string | number;
  rationale: string;
  impact: 'performance' | 'memory' | 'quality';
}

export interface ModelfileOutput {
  content: string;
  recommendations: Recommendation[];
  estimatedVramMb: number;
  maxContextTokens: number;
  numGpu: number;
  numThread: number;
  numBatch: number;
  splitRatio: string;
  storageAdvice: string;
}

// -- KV Cache Type Recommendations ----------------------------------

const KV_CACHE_TYPES = {
  f16: { memoryMultiplier: 1.0, label: 'FP16 (default, highest quality)' },
  q8_0: { memoryMultiplier: 0.5, label: 'Q8_0 (half memory, minimal loss)' },
  q4_0: { memoryMultiplier: 0.25, label: 'Q4_0 (quarter memory, some loss)' },
} as const;

// -- Use Case Templates ---------------------------------------------

const USE_CASE_DEFAULTS: Record<string, Partial<ModelfileConfig>> = {
  chat: {
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    repeatPenalty: 1.1,
    systemPrompt: 'You are a helpful, friendly assistant. Respond clearly and concisely.',
  },
  coding: {
    temperature: 0.2,
    topP: 0.95,
    topK: 20,
    repeatPenalty: 1.0,
    systemPrompt: 'You are an expert software engineer. Write clean, well-documented code. Explain your reasoning when asked.',
  },
  analysis: {
    temperature: 0.3,
    topP: 0.9,
    topK: 30,
    repeatPenalty: 1.1,
    systemPrompt: 'You are a data analyst. Provide thorough, evidence-based analysis. Structure your responses clearly.',
  },
  creative: {
    temperature: 0.9,
    topP: 0.95,
    topK: 60,
    repeatPenalty: 1.2,
    systemPrompt: 'You are a creative writer. Be imaginative, vivid, and original in your responses.',
  },
  agent: {
    temperature: 0.1,
    topP: 0.9,
    topK: 20,
    repeatPenalty: 1.0,
    systemPrompt: 'You are an AI agent. Follow instructions precisely. Use tools when available. Think step by step.',
  },
};

// -- Generator ------------------------------------------------------

export class ModelfileGenerator {
  async generate(
    hardware: HardwareProfile,
    config: ModelfileConfig
  ): Promise<ModelfileOutput> {
    const recommendations: Recommendation[] = [];

    // Get model info for sizing calculations
    let modelInfo: ModelInfo | null = null;
    let archInfo: ModelArchInfo | null = null;
    try {
      modelInfo = await ollama.showModel(config.baseModel);
      archInfo = parseModelArch(modelInfo);
    } catch {
      recommendations.push({
        parameter: 'info',
        value: 'fallback',
        rationale: `Could not fetch model info for ${config.baseModel}. Using heuristic estimates.`,
        impact: 'quality',
      });
    }

    // Determine model size and architecture
    const modelSizeMb = this.estimateModelSizeMb(config.baseModel, modelInfo);
    const blockCount = archInfo?.blockCount || this.estimateBlockCount(config.baseModel);
    const billions = this.extractBillions(config.baseModel);

    // Calculate GPU layer offload (num_gpu)
    const numGpu = config.numGpu ?? this.calculateNumGpu(hardware, modelSizeMb, blockCount, recommendations);

    // Calculate thread count
    const numThread = config.numThread ?? this.calculateNumThread(hardware, numGpu, blockCount, recommendations);

    // Calculate batch size
    const numBatch = config.numBatch ?? this.calculateNumBatch(hardware, modelSizeMb, numGpu, blockCount, recommendations);

    // Determine available memory for KV cache
    const gpuLayersMb = blockCount > 0 ? (modelSizeMb / blockCount) * numGpu : 0;
    const availableForKv = hardware.gpuVramMb > 0
      ? Math.max(0, hardware.gpuVramMb - gpuLayersMb - 512)
      : Math.max(0, hardware.systemRamMb - modelSizeMb - 512);

    // Recommend KV cache type
    const kvCacheType = config.kvCacheType || this.recommendKvCacheType(availableForKv, modelSizeMb);
    const kvMultiplier = KV_CACHE_TYPES[kvCacheType as keyof typeof KV_CACHE_TYPES]?.memoryMultiplier ?? 1.0;

    if (kvCacheType !== 'f16') {
      recommendations.push({
        parameter: 'kv_cache_type',
        value: kvCacheType,
        rationale: `${kvCacheType} reduces KV cache memory by ${Math.round((1 - kvMultiplier) * 100)}% to maximize context window within ${Math.round(availableForKv)}MB available.`,
        impact: 'memory',
      });
    }

    // Calculate optimal context size
    const kvBytesPerToken = this.estimateKvBytesPerToken(billions, archInfo) * kvMultiplier;
    const maxCtxFromMemory = kvBytesPerToken > 0
      ? Math.floor((availableForKv * 1024 * 1024) / kvBytesPerToken)
      : 4096;
    const maxContextTokens = config.maxContextTokens || Math.min(Math.max(maxCtxFromMemory, 2048), 131072);

    recommendations.push({
      parameter: 'num_ctx',
      value: maxContextTokens,
      rationale: `Context window calculated from ${Math.round(availableForKv)}MB available memory after model layers and overhead.`,
      impact: 'memory',
    });

    // Split ratio description
    const gpuPercent = blockCount > 0 ? Math.round((numGpu / blockCount) * 100) : 0;
    const splitRatio = numGpu === 0
      ? 'CPU only — no GPU offload'
      : numGpu >= blockCount
      ? '100% GPU — full model in VRAM'
      : `${gpuPercent}% GPU / ${100 - gpuPercent}% CPU (${numGpu}/${blockCount} layers)`;

    // PCIe bandwidth note for split inference
    if (numGpu > 0 && numGpu < blockCount && hardware.pcieGeneration) {
      const bw = hardware.pcieBandwidthGBs || 0;
      recommendations.push({
        parameter: 'pcie',
        value: `Gen ${hardware.pcieGeneration}`,
        rationale: `Split inference uses PCIe ${hardware.pcieGeneration}.0 at ~${bw} GB/s. CPU↔GPU transfer adds latency per token.`,
        impact: 'performance',
      });
    }

    // Storage advice
    const storageAdvice = modelSizeMb > hardware.gpuVramMb
      ? 'Model exceeds VRAM — ensure model files are on NVMe for fastest loading. Avoid HDD.'
      : 'Model fits in VRAM — storage speed only affects initial load time.';

    // Merge use case defaults with overrides
    const useCaseDefaults = USE_CASE_DEFAULTS[config.useCase] || USE_CASE_DEFAULTS.chat;
    const finalConfig = { ...useCaseDefaults, ...config };

    // Estimate total VRAM usage
    const kvCacheMb = (maxContextTokens * kvBytesPerToken) / (1024 * 1024);
    const estimatedVramMb = Math.round(gpuLayersMb + kvCacheMb + 512);

    // Generate Modelfile content
    const content = this.buildModelfile(finalConfig, maxContextTokens, numGpu, numThread, numBatch, recommendations);

    return {
      content,
      recommendations,
      estimatedVramMb,
      maxContextTokens,
      numGpu,
      numThread,
      numBatch,
      splitRatio,
      storageAdvice,
    };
  }

  private calculateNumGpu(
    hardware: HardwareProfile,
    modelSizeMb: number,
    blockCount: number,
    recommendations: Recommendation[]
  ): number {
    if (hardware.gpuVramMb <= 0 || blockCount <= 0) {
      recommendations.push({
        parameter: 'num_gpu',
        value: 0,
        rationale: 'No GPU detected or model architecture unknown. Running on CPU.',
        impact: 'performance',
      });
      return 0;
    }

    const perLayerMb = modelSizeMb / blockCount;
    // Reserve 20% of VRAM for KV cache + activations + overhead
    const usableVramMb = hardware.gpuVramMb * 0.80;
    const fittableLayers = Math.floor(usableVramMb / perLayerMb);
    const numGpu = Math.min(fittableLayers, blockCount);

    recommendations.push({
      parameter: 'num_gpu',
      value: numGpu,
      rationale: `${numGpu}/${blockCount} layers fit in ${hardware.gpuVramMb}MB VRAM (~${Math.round(perLayerMb)}MB/layer, 20% reserved for KV cache).`,
      impact: 'performance',
    });

    return numGpu;
  }

  private calculateNumThread(
    hardware: HardwareProfile,
    numGpu: number,
    blockCount: number,
    recommendations: Recommendation[]
  ): number {
    const physical = hardware.cpuPhysicalCores || Math.max(1, Math.floor(hardware.cpuCores / 2));
    const numaNodes = hardware.numaNodes || 1;
    const coresPerNuma = hardware.coresPerNuma || physical;

    let numThread: number;
    let rationale: string;

    if (numGpu >= blockCount && blockCount > 0) {
      // Full GPU offload — CPU only handles pre/post processing
      numThread = Math.max(1, Math.floor(physical / 2));
      rationale = `Full GPU offload — CPU handles pre/post processing only. Using ${numThread}/${physical} physical cores.`;
    } else if (numGpu > 0) {
      // Partial offload — CPU does significant compute
      if (numaNodes > 1) {
        // NUMA-aware: use cores from adjacent NUMA nodes to minimize cross-node latency
        // Optimal: threads aligned to NUMA node boundaries
        const cpuLayers = blockCount - numGpu;
        const numaNodesNeeded = Math.min(numaNodes, Math.max(1, Math.ceil(cpuLayers / (blockCount / numaNodes))));
        numThread = Math.max(1, numaNodesNeeded * coresPerNuma - 1);
        rationale = `Split inference (${cpuLayers} CPU layers) — NUMA-aligned: ${numaNodesNeeded}/${numaNodes} NUMA nodes x ${coresPerNuma} cores. Using ${numThread} threads for cross-node memory locality.`;
      } else {
        numThread = Math.max(1, physical - 2);
        rationale = `Split inference — CPU computes ${blockCount - numGpu} layers. Using ${numThread}/${physical} physical cores (2 reserved for OS/Ollama).`;
      }
    } else {
      // CPU only — use most cores, NUMA-aligned
      if (numaNodes > 1) {
        // For CPU-only on multi-NUMA, use all nodes but leave 1 core per node for OS
        numThread = Math.max(1, physical - numaNodes);
        rationale = `CPU-only inference on ${numaNodes}-node NUMA topology (${coresPerNuma} cores/node). Using ${numThread}/${physical} cores (1 reserved per NUMA node for OS/memory controller).`;
      } else {
        numThread = Math.max(1, physical - 1);
        rationale = `CPU-only inference. Using ${numThread}/${physical} physical cores (1 reserved for OS).`;
      }
    }

    recommendations.push({
      parameter: 'num_thread',
      value: numThread,
      rationale,
      impact: 'performance',
    });

    if (numaNodes > 1) {
      recommendations.push({
        parameter: 'numa',
        value: `${numaNodes} nodes`,
        rationale: `Multi-NUMA CPU detected (${numaNodes} nodes, ${coresPerNuma} cores each). Thread count aligned to NUMA boundaries for optimal memory access latency.`,
        impact: 'performance',
      });
    }

    return numThread;
  }

  private calculateNumBatch(
    hardware: HardwareProfile,
    modelSizeMb: number,
    numGpu: number,
    blockCount: number,
    recommendations: Recommendation[]
  ): number {
    let numBatch = 512; // Ollama default
    let rationale: string;

    if (hardware.gpuVramMb > 0 && numGpu > 0) {
      const gpuLayersMb = blockCount > 0 ? (modelSizeMb / blockCount) * numGpu : modelSizeMb;
      const vramHeadroom = hardware.gpuVramMb - gpuLayersMb - 512;

      if (vramHeadroom > 2048) {
        numBatch = 2048;
        rationale = `${Math.round(vramHeadroom)}MB VRAM headroom — large batch for faster prompt eval.`;
      } else if (vramHeadroom > 1024) {
        numBatch = 1024;
        rationale = `${Math.round(vramHeadroom)}MB VRAM headroom — increased batch size.`;
      } else if (vramHeadroom > 256) {
        numBatch = 512;
        rationale = `${Math.round(vramHeadroom)}MB VRAM headroom — default batch size.`;
      } else {
        numBatch = 256;
        rationale = `Tight VRAM (${Math.round(vramHeadroom)}MB headroom) — reduced batch to prevent OOM.`;
      }
    } else {
      // CPU only — batch size limited by memory bandwidth
      numBatch = 512;
      rationale = 'CPU inference — default batch size (limited by memory bandwidth, not VRAM).';
    }

    recommendations.push({
      parameter: 'num_batch',
      value: numBatch,
      rationale,
      impact: 'performance',
    });

    return numBatch;
  }

  private buildModelfile(
    config: ModelfileConfig & Partial<typeof USE_CASE_DEFAULTS.chat>,
    numCtx: number,
    numGpu: number,
    numThread: number,
    numBatch: number,
    recommendations: Recommendation[]
  ): string {
    const lines: string[] = [
      `# Inference Forge — Auto-generated Modelfile`,
      `# Model: ${config.customName}`,
      `# Use case: ${config.useCase}`,
      `# Generated: ${new Date().toISOString()}`,
      `#`,
      ...recommendations.map((r) => `# [${r.impact}] ${r.parameter}: ${r.rationale}`),
      ``,
      `FROM ${config.baseModel}`,
      ``,
      `# Hardware-optimized parameters`,
      `PARAMETER num_gpu ${numGpu}`,
      `PARAMETER num_thread ${numThread}`,
      `PARAMETER num_batch ${numBatch}`,
      `PARAMETER num_ctx ${numCtx}`,
      ``,
      `# Sampling parameters (optimized for ${config.useCase})`,
      `PARAMETER temperature ${config.temperature ?? 0.7}`,
      `PARAMETER top_p ${config.topP ?? 0.9}`,
      `PARAMETER top_k ${config.topK ?? 40}`,
      `PARAMETER repeat_penalty ${config.repeatPenalty ?? 1.1}`,
    ];

    if (config.systemPrompt) {
      lines.push('', `SYSTEM """`, config.systemPrompt, `"""`);
    }

    return lines.join('\n') + '\n';
  }

  private estimateModelSizeMb(name: string, info: ModelInfo | null): number {
    // Try to get actual size from model info parameter_size
    if (info?.details?.parameter_size) {
      const match = info.details.parameter_size.match(/([\d.]+)\s*B/i);
      if (match) {
        const billions = parseFloat(match[1]);
        // Quantized models: estimate based on quantization level
        const quantLevel = info.details.quantization_level?.toLowerCase() || '';
        const bytesPerParam = quantLevel.includes('q4') ? 0.5
          : quantLevel.includes('q5') ? 0.625
          : quantLevel.includes('q6') ? 0.75
          : quantLevel.includes('q8') ? 1.0
          : quantLevel.includes('f16') ? 2.0
          : 0.5; // default to Q4 estimate
        return Math.round(billions * 1000 * bytesPerParam);
      }
    }
    // Fallback: parse from name
    const match = name.match(/(\d+\.?\d*)[bB]/);
    if (match) {
      return Math.round(parseFloat(match[1]) * 1000 * 0.5);
    }
    return 4096;
  }

  private estimateBlockCount(name: string): number {
    // Rough estimates for common model sizes
    const billions = this.extractBillions(name);
    if (billions <= 1) return 16;
    if (billions <= 3) return 26;
    if (billions <= 7) return 32;
    if (billions <= 14) return 40;
    if (billions <= 34) return 60;
    if (billions <= 70) return 80;
    return 96;
  }

  private extractBillions(name: string): number {
    const match = name.match(/(\d+\.?\d*)[bB]/);
    return match ? parseFloat(match[1]) : 7;
  }

  private estimateKvBytesPerToken(billions: number, archInfo: ModelArchInfo | null): number {
    if (archInfo && archInfo.embeddingLength > 0 && archInfo.headCountKv > 0) {
      // Precise calculation: 2 (K+V) * layers * kv_heads * head_dim * 2 bytes (f16)
      const headDim = archInfo.embeddingLength / archInfo.headCount;
      return 2 * archInfo.blockCount * archInfo.headCountKv * headDim * 2;
    }
    // Fallback heuristic
    return Math.round(256 * (billions / 7));
  }

  private recommendKvCacheType(memoryForKvMb: number, modelSizeMb: number): string {
    if (memoryForKvMb > modelSizeMb * 0.5) return 'f16';
    if (memoryForKvMb > modelSizeMb * 0.25) return 'q8_0';
    return 'q4_0';
  }
}

export const modelfileGenerator = new ModelfileGenerator();
