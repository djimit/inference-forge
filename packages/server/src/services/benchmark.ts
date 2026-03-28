/**
 * KV Cache Benchmark Service
 * Runs standardized benchmarks across different KV cache configurations.
 */

import { ollama, type GenerateResponse } from './ollama.js';

export interface BenchmarkConfig {
  model: string;
  kvCacheTypes: string[];     // e.g. ['f16', 'q8_0', 'q4_0']
  prompts: BenchmarkPrompt[];
  runs: number;               // repetitions per config
}

export interface BenchmarkPrompt {
  label: string;
  text: string;
  expectedTokens: number;     // rough expected output length
}

export interface BenchmarkResult {
  model: string;
  kvCacheType: string;
  prompt: string;
  run: number;
  tokensPerSecond: number;
  totalDurationMs: number;
  loadDurationMs: number;
  promptEvalCount: number;
  promptEvalDurationMs: number;
  evalCount: number;
  evalDurationMs: number;
  timestamp: number;
}

export interface BenchmarkSummary {
  model: string;
  results: BenchmarkResult[];
  summary: Array<{
    kvCacheType: string;
    avgTokensPerSecond: number;
    avgTotalDurationMs: number;
    avgEvalDurationMs: number;
    totalRuns: number;
  }>;
  startedAt: number;
  completedAt: number;
}

type ProgressCallback = (message: string, progress: number) => void;

// ── Standard benchmark prompts ─────────────────────────────────────

export const STANDARD_PROMPTS: BenchmarkPrompt[] = [
  {
    label: 'short',
    text: 'Explain what a KV cache is in large language models in one paragraph.',
    expectedTokens: 100,
  },
  {
    label: 'medium',
    text: `Write a detailed technical explanation of how transformer attention mechanisms work,
including multi-head attention, query-key-value projections, and the role of positional
encodings. Include specific mathematical formulations where relevant.`,
    expectedTokens: 500,
  },
  {
    label: 'long-context',
    text: `You are a senior software architect writing a comprehensive design document.
Create a complete system design for a real-time monitoring dashboard that tracks
GPU utilization, memory allocation, model inference latency, and throughput metrics.
Include sections on: 1) System architecture with component descriptions,
2) Data flow and storage design, 3) API specifications, 4) Frontend component hierarchy,
5) Scalability considerations, 6) Security measures, 7) Deployment strategy.
Be thorough and specific with technology choices and trade-offs.`,
    expectedTokens: 1500,
  },
];

// ── Benchmark Runner ───────────────────────────────────────────────

export class BenchmarkService {
  private running = false;

  isRunning(): boolean {
    return this.running;
  }

  async run(
    config: BenchmarkConfig,
    onProgress?: ProgressCallback
  ): Promise<BenchmarkSummary> {
    if (this.running) {
      throw new Error('Benchmark already in progress');
    }

    this.running = true;
    const startedAt = Date.now();
    const results: BenchmarkResult[] = [];

    const totalSteps = config.kvCacheTypes.length * config.prompts.length * config.runs;
    let currentStep = 0;

    try {
      for (const kvType of config.kvCacheTypes) {
        onProgress?.(
          `Testing KV cache type: ${kvType}`,
          currentStep / totalSteps
        );

        for (const prompt of config.prompts) {
          for (let run = 0; run < config.runs; run++) {
            currentStep++;
            onProgress?.(
              `[${kvType}] ${prompt.label} — run ${run + 1}/${config.runs}`,
              currentStep / totalSteps
            );

            const result = await this.runSingle(
              config.model,
              kvType,
              prompt
            );
            results.push({ ...result, run: run + 1 });
          }
        }
      }

      // Build summary
      const summary = config.kvCacheTypes.map((kvType) => {
        const kvResults = results.filter((r) => r.kvCacheType === kvType);
        const avgTps =
          kvResults.reduce((s, r) => s + r.tokensPerSecond, 0) / kvResults.length;
        const avgTotal =
          kvResults.reduce((s, r) => s + r.totalDurationMs, 0) / kvResults.length;
        const avgEval =
          kvResults.reduce((s, r) => s + r.evalDurationMs, 0) / kvResults.length;

        return {
          kvCacheType: kvType,
          avgTokensPerSecond: Math.round(avgTps * 100) / 100,
          avgTotalDurationMs: Math.round(avgTotal),
          avgEvalDurationMs: Math.round(avgEval),
          totalRuns: kvResults.length,
        };
      });

      onProgress?.('Benchmark complete', 1);

      return {
        model: config.model,
        results,
        summary,
        startedAt,
        completedAt: Date.now(),
      };
    } finally {
      this.running = false;
    }
  }

  private async runSingle(
    model: string,
    kvCacheType: string,
    prompt: BenchmarkPrompt
  ): Promise<BenchmarkResult> {
    // Note: KV cache type is set via OLLAMA_KV_CACHE_TYPE env var on Ollama server
    // The benchmark records which type was active during the run
    const response: GenerateResponse = await ollama.generate({
      model,
      prompt: prompt.text,
      stream: false,
    });

    const totalDurationMs = (response.total_duration || 0) / 1_000_000;
    const loadDurationMs = (response.load_duration || 0) / 1_000_000;
    const promptEvalDurationMs = (response.prompt_eval_duration || 0) / 1_000_000;
    const evalDurationMs = (response.eval_duration || 0) / 1_000_000;
    const evalCount = response.eval_count || 0;
    const tokensPerSecond = evalDurationMs > 0 ? (evalCount / evalDurationMs) * 1000 : 0;

    return {
      model,
      kvCacheType,
      prompt: prompt.label,
      run: 0, // set by caller
      tokensPerSecond: Math.round(tokensPerSecond * 100) / 100,
      totalDurationMs: Math.round(totalDurationMs),
      loadDurationMs: Math.round(loadDurationMs),
      promptEvalCount: response.prompt_eval_count || 0,
      promptEvalDurationMs: Math.round(promptEvalDurationMs),
      evalCount,
      evalDurationMs: Math.round(evalDurationMs),
      timestamp: Date.now(),
    };
  }
}

export const benchmark = new BenchmarkService();
