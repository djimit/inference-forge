/**
 * Smart Modelfile Generator
 * Generates optimized Ollama Modelfiles based on hardware specs and model characteristics.
 */

import { ollama, type ModelInfo } from './ollama.js';

// ── Types ──────────────────────────────────────────────────────────

export interface HardwareProfile {
  gpuVramMb: number;       // GPU VRAM in MB (0 if CPU only)
  systemRamMb: number;     // Total system RAM in MB
  gpuName: string;         // GPU model name
  cpuCores: number;        // Number of CPU cores
}

export interface ModelfileConfig {
  baseModel: string;       // e.g. "llama3.2:latest"
  customName: string;      // name for the custom model
  useCase: 'chat' | 'coding' | 'analysis' | 'creative' | 'agent';
  maxContextTokens?: number;  // override auto-calculated
  kvCacheType?: string;       // override auto-recommended
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
}

export interface ModelfileOutput {
  content: string;         // The Modelfile text
  recommendations: string[];  // Explanatory notes
  estimatedVramMb: number;    // Expected VRAM usage
  maxContextTokens: number;
}

// ── KV Cache Type Recommendations ──────────────────────────────────

const KV_CACHE_TYPES = {
  f16: { memoryMultiplier: 1.0, label: 'FP16 (default, highest quality)' },
  q8_0: { memoryMultiplier: 0.5, label: 'Q8_0 (half memory, minimal loss)' },
  q4_0: { memoryMultiplier: 0.25, label: 'Q4_0 (quarter memory, some loss)' },
} as const;

// ── Use Case Templates ─────────────────────────────────────────────

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

// ── Generator ──────────────────────────────────────────────────────

export class ModelfileGenerator {
  /**
   * Generate an optimized Modelfile based on hardware and use case.
   */
  async generate(
    hardware: HardwareProfile,
    config: ModelfileConfig
  ): Promise<ModelfileOutput> {
    const recommendations: string[] = [];

    // Get model info for sizing calculations
    let modelInfo: ModelInfo | null = null;
    try {
      modelInfo = await ollama.showModel(config.baseModel);
    } catch {
      recommendations.push(
        `Could not fetch model info for ${config.baseModel}. Using defaults.`
      );
    }

    // Determine model size in MB
    const modelSizeMb = this.estimateModelSizeMb(config.baseModel, modelInfo);

    // Determine available memory for KV cache
    const availableVram = hardware.gpuVramMb > 0 ? hardware.gpuVramMb : hardware.systemRamMb;
    const memoryForKv = Math.max(0, availableVram - modelSizeMb - 512); // 512MB overhead buffer

    // Recommend KV cache type
    const kvCacheType = config.kvCacheType || this.recommendKvCacheType(memoryForKv, modelSizeMb, hardware);
    const kvMultiplier = KV_CACHE_TYPES[kvCacheType as keyof typeof KV_CACHE_TYPES]?.memoryMultiplier ?? 1.0;

    if (kvCacheType !== 'f16') {
      recommendations.push(
        `Recommended ${kvCacheType} KV cache to maximize context window within ${availableVram}MB available memory.`
      );
      recommendations.push(
        `Set OLLAMA_KV_CACHE_TYPE=${kvCacheType} environment variable before starting Ollama.`
      );
      recommendations.push(
        `Requires Flash Attention support. Ollama will fall back to f16 if unsupported.`
      );
    }

    // Calculate optimal context size
    const kvBytesPerToken = this.estimateKvBytesPerToken(config.baseModel, modelInfo) * kvMultiplier;
    const maxCtxFromMemory = Math.floor((memoryForKv * 1024 * 1024) / kvBytesPerToken);
    const maxContextTokens = config.maxContextTokens || Math.min(maxCtxFromMemory, 131072); // cap at 128k

    recommendations.push(
      `Calculated ${maxContextTokens.toLocaleString()} token context window based on ${availableVram}MB available memory.`
    );

    // Merge use case defaults with overrides
    const useCaseDefaults = USE_CASE_DEFAULTS[config.useCase] || USE_CASE_DEFAULTS.chat;
    const finalConfig = { ...useCaseDefaults, ...config };

    // Estimate total VRAM usage
    const kvCacheMb = (maxContextTokens * kvBytesPerToken) / (1024 * 1024);
    const estimatedVramMb = Math.round(modelSizeMb + kvCacheMb + 512);

    // Generate Modelfile content
    const content = this.buildModelfile(finalConfig, maxContextTokens, recommendations);

    return {
      content,
      recommendations,
      estimatedVramMb,
      maxContextTokens,
    };
  }

  private buildModelfile(
    config: ModelfileConfig & Partial<typeof USE_CASE_DEFAULTS.chat>,
    numCtx: number,
    recommendations: string[]
  ): string {
    const lines: string[] = [
      `# Inference Forge — Auto-generated Modelfile`,
      `# Model: ${config.customName}`,
      `# Use case: ${config.useCase}`,
      `# Generated: ${new Date().toISOString()}`,
      `#`,
      ...recommendations.map((r) => `# ${r}`),
      ``,
      `FROM ${config.baseModel}`,
      ``,
      `# Context window`,
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

  private estimateModelSizeMb(name: string, _info: ModelInfo | null): number {
    // Parse parameter size from model name heuristic
    const match = name.match(/(\d+\.?\d*)[bB]/);
    if (match) {
      const billions = parseFloat(match[1]);
      // Q4 quantized models ≈ 0.5 bytes per param
      return Math.round(billions * 1000 * 0.5);
    }
    return 4096; // default 4GB estimate
  }

  private estimateKvBytesPerToken(name: string, _info: ModelInfo | null): number {
    // KV cache bytes per token depends on model architecture
    // Rough estimates for common architectures at f16:
    // 7B ≈ 256 bytes/token, 13B ≈ 384, 70B ≈ 1280
    const match = name.match(/(\d+\.?\d*)[bB]/);
    if (match) {
      const billions = parseFloat(match[1]);
      return Math.round(256 * (billions / 7));
    }
    return 256;
  }

  private recommendKvCacheType(
    memoryForKvMb: number,
    modelSizeMb: number,
    hardware: HardwareProfile
  ): string {
    // If plenty of memory, use f16
    if (memoryForKvMb > modelSizeMb * 0.5) return 'f16';
    // If moderate memory, use q8
    if (memoryForKvMb > modelSizeMb * 0.25) return 'q8_0';
    // Tight on memory, use q4
    return 'q4_0';
  }
}

export const modelfileGenerator = new ModelfileGenerator();
