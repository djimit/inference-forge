/**
 * Benchmark Service
 * Runs standardized benchmarks across KV cache types, GPU offload, thread count,
 * context length, and batch size configurations.
 */

import { ollama, type GenerateResponse } from './ollama.js';

// -- Types ----------------------------------------------------------

export type BenchmarkMode = 'kv-cache' | 'gpu-offload' | 'thread-count' | 'context-length' | 'batch-size';

export interface BenchmarkConfig {
  model: string;
  kvCacheTypes: string[];
  prompts: BenchmarkPrompt[];
  runs: number;
  warmupRuns?: number;
}

export interface ExpandedBenchmarkConfig {
  mode: BenchmarkMode;
  model: string;
  runs: number;
  prompts?: BenchmarkPrompt[];
  kvCacheTypes?: string[];
  gpuLayerSteps?: number[];
  threadCountSteps?: number[];
  contextLengthSteps?: number[];
  batchSizeSteps?: number[];
}

export interface BenchmarkPrompt {
  label: string;
  text: string;
  expectedTokens: number;
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

export interface ExpandedBenchmarkResult extends BenchmarkResult {
  mode: BenchmarkMode;
  numGpu?: number;
  numThread?: number;
  numCtx?: number;
  numBatch?: number;
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
  warmup?: {
    avgTokensPerSecond: number;
    warmupRuns: number;
    coldStartPenalty: number;
  };
  validated: boolean;
  issues: ValidationIssue[];
  confidence: 'high' | 'medium' | 'low';
}

export interface ValidationIssue {
  severity: 'warning' | 'error';
  stage: 'correctness' | 'performance';
  message: string;
  run?: number;
  value?: number;
}

export interface ValidatedBenchmarkResult extends BenchmarkResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ExpandedBenchmarkSummary {
  id: string;
  mode: BenchmarkMode;
  model: string;
  results: ExpandedBenchmarkResult[];
  summary: Array<{
    label: string;
    variable: string;
    variableValue: number | string;
    avgTokensPerSecond: number;
    avgTotalDurationMs: number;
    avgEvalDurationMs: number;
    avgPromptEvalTps: number;
    totalRuns: number;
  }>;
  startedAt: number;
  completedAt: number;
  warmup?: {
    avgTokensPerSecond: number;
    warmupRuns: number;
    coldStartPenalty: number;
  };
  validated: boolean;
  issues: ValidationIssue[];
  confidence: 'high' | 'medium' | 'low';
}

type ProgressCallback = (message: string, progress: number) => void;
type ExpandedParameterKey = 'numGpu' | 'numThread' | 'numCtx' | 'numBatch';

// -- Standard benchmark prompts -------------------------------------

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

// -- Benchmark Runner -----------------------------------------------

export class BenchmarkService {
  private running = false;
  private progressListeners: Set<ProgressCallback> = new Set();

  isRunning(): boolean {
    return this.running;
  }

  subscribeProgress(cb: ProgressCallback): () => void {
    this.progressListeners.add(cb);
    return () => this.progressListeners.delete(cb);
  }

  private emitProgress(message: string, progress: number): void {
    for (const cb of this.progressListeners) {
      try { cb(message, progress); } catch {}
    }
  }

  // Legacy KV-cache-only benchmark (backward compatible)
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
      // Warmup phase
      const warmupRuns = config.warmupRuns ?? 1;
      let warmupTps = 0;
      let warmupCount = 0;
      if (warmupRuns > 0) {
        for (const prompt of config.prompts) {
          for (let w = 0; w < warmupRuns; w++) {
            const msg = `[warmup] ${prompt.label} — run ${w + 1}/${warmupRuns}`;
            onProgress?.(msg, 0);
            this.emitProgress(msg, 0);
            const warmupResult = await this.runSingle(config.model, prompt);
            warmupTps += warmupResult.tokensPerSecond;
            warmupCount++;
          }
        }
      }

      for (const kvType of config.kvCacheTypes) {
        const msg = `Testing KV cache type: ${kvType}`;
        onProgress?.(msg, currentStep / totalSteps);
        this.emitProgress(msg, currentStep / totalSteps);

        for (const prompt of config.prompts) {
          for (let run = 0; run < config.runs; run++) {
            currentStep++;
            const msg = `[${kvType}] ${prompt.label} — run ${run + 1}/${config.runs}`;
            onProgress?.(msg, currentStep / totalSteps);
            this.emitProgress(msg, currentStep / totalSteps);

            const result = await this.runSingle(config.model, prompt);
            results.push({ ...result, kvCacheType: kvType, run: run + 1 });
          }
        }
      }

      const summary = config.kvCacheTypes.map((kvType) => {
        const kvResults = results.filter((r) => r.kvCacheType === kvType);
        const avgTps = average(kvResults.map((r) => r.tokensPerSecond));
        const avgTotal = kvResults.reduce((s, r) => s + r.totalDurationMs, 0) / kvResults.length;
        const avgEval = kvResults.reduce((s, r) => s + r.evalDurationMs, 0) / kvResults.length;

        return {
          kvCacheType: kvType,
          avgTokensPerSecond: Math.round(avgTps * 100) / 100,
          avgTotalDurationMs: Math.round(avgTotal),
          avgEvalDurationMs: Math.round(avgEval),
          totalRuns: kvResults.length,
        };
      });

      onProgress?.('Benchmark complete', 1);
      this.emitProgress('Benchmark complete', 1);

      const warmupAvg = warmupCount > 0 ? warmupTps / warmupCount : 0;
      const measAvg = average(results.map((r) => r.tokensPerSecond));
      const coldStartPenalty = measAvg > 0 ? Math.round(((measAvg - warmupAvg) / measAvg) * 100) : 0;

      const validation = this.validateResults(results, config.prompts);

      return {
        model: config.model,
        results,
        summary,
        startedAt,
        completedAt: Date.now(),
        warmup: warmupCount > 0 ? {
          avgTokensPerSecond: Math.round(warmupAvg * 100) / 100,
          warmupRuns,
          coldStartPenalty,
        } : undefined,
        validated: validation.validated,
        issues: validation.issues,
        confidence: validation.confidence,
      };
    } finally {
      this.running = false;
    }
  }

  // Expanded multi-mode benchmark
  async runExpanded(
    config: ExpandedBenchmarkConfig,
    onProgress?: ProgressCallback
  ): Promise<ExpandedBenchmarkSummary> {
    if (this.running) {
      throw new Error('Benchmark already in progress');
    }

    this.running = true;
    const startedAt = Date.now();
    const prompts = config.prompts?.length ? config.prompts : [STANDARD_PROMPTS[0]];
    const runs = config.runs || 2;

    try {
      let results: ExpandedBenchmarkResult[];
      let summaryItems: ExpandedBenchmarkSummary['summary'];

      switch (config.mode) {
        case 'kv-cache': {
          const types = config.kvCacheTypes || ['f16', 'q8_0', 'q4_0'];
          ({ results, summaryItems } = await this.sweepKvCache(config.model, types, prompts, runs, onProgress));
          break;
        }
        case 'gpu-offload': {
          const steps = config.gpuLayerSteps || [0, 8, 16, 24, 32];
          ({ results, summaryItems } = await this.sweepParameter(
            config.model, 'num_gpu', steps, prompts, runs, onProgress
          ));
          break;
        }
        case 'thread-count': {
          const steps = config.threadCountSteps || [1, 4, 8, 12, 16, 20, 24];
          ({ results, summaryItems } = await this.sweepParameter(
            config.model, 'num_thread', steps, prompts, runs, onProgress
          ));
          break;
        }
        case 'context-length': {
          const steps = config.contextLengthSteps || [2048, 4096, 8192, 16384];
          ({ results, summaryItems } = await this.sweepParameter(
            config.model, 'num_ctx', steps, prompts, runs, onProgress
          ));
          break;
        }
        case 'batch-size': {
          const steps = config.batchSizeSteps || [128, 256, 512, 1024, 2048];
          ({ results, summaryItems } = await this.sweepParameter(
            config.model, 'num_batch', steps, prompts, runs, onProgress
          ));
          break;
        }
        default:
          throw new Error(`Unknown benchmark mode: ${config.mode}`);
      }

      const msg = 'Benchmark complete';
      onProgress?.(msg, 1);
      this.emitProgress(msg, 1);

      const validation = this.validateResults(results, prompts);

      return {
        id: `bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mode: config.mode,
        model: config.model,
        results,
        summary: summaryItems,
        startedAt,
        completedAt: Date.now(),
        warmup: undefined,
        validated: validation.validated,
        issues: validation.issues,
        confidence: validation.confidence,
      };
    } finally {
      this.running = false;
    }
  }

  private async sweepKvCache(
    model: string,
    types: string[],
    prompts: BenchmarkPrompt[],
    runs: number,
    onProgress?: ProgressCallback
  ) {
    const results: ExpandedBenchmarkResult[] = [];
    const total = types.length * prompts.length * runs;
    let step = 0;

    for (const kvType of types) {
      for (const prompt of prompts) {
        for (let run = 0; run < runs; run++) {
          step++;
          const msg = `[${kvType}] ${prompt.label} — run ${run + 1}/${runs}`;
          onProgress?.(msg, step / total);
          this.emitProgress(msg, step / total);

          const base = await this.runSingle(model, prompt);
          results.push({ ...base, mode: 'kv-cache', kvCacheType: kvType, run: run + 1 });
        }
      }
    }

    const summaryItems = types.map((kvType) => {
      const filtered = results.filter((r) => r.kvCacheType === kvType);
      return this.buildSummaryItem(kvType, 'kvCacheType', kvType, filtered);
    });

    return { results, summaryItems };
  }

  private async sweepParameter(
    model: string,
    paramName: string,
    steps: number[],
    prompts: BenchmarkPrompt[],
    runs: number,
    onProgress?: ProgressCallback
  ) {
    const results: ExpandedBenchmarkResult[] = [];
    const total = steps.length * prompts.length * runs;
    let step = 0;

    const modeMap: Record<string, BenchmarkMode> = {
      num_gpu: 'gpu-offload',
      num_thread: 'thread-count',
      num_ctx: 'context-length',
      num_batch: 'batch-size',
    };
    const mode = modeMap[paramName] || 'kv-cache';

    const metaKey: Record<string, ExpandedParameterKey> = {
      num_gpu: 'numGpu',
      num_thread: 'numThread',
      num_ctx: 'numCtx',
      num_batch: 'numBatch',
    };

    for (const value of steps) {
      for (const prompt of prompts) {
        for (let run = 0; run < runs; run++) {
          step++;
          const msg = `[${paramName}=${value}] ${prompt.label} — run ${run + 1}/${runs}`;
          onProgress?.(msg, step / total);
          this.emitProgress(msg, step / total);

          const options = { [paramName]: value };
          const base = await this.runSingle(model, prompt, options);
          const expanded: ExpandedBenchmarkResult = {
            ...base,
            mode,
            run: run + 1,
          };
          const key = metaKey[paramName];
          if (key) {
            setExpandedParameter(expanded, key, value);
          }
          results.push(expanded);
        }
      }
    }

    const summaryItems = steps.map((value) => {
      const key = metaKey[paramName];
      const filtered = results.filter((r) => key ? r[key] === value : false);
      return this.buildSummaryItem(`${paramName}=${value}`, paramName, value, filtered);
    });

    return { results, summaryItems };
  }

  private validateResults(results: BenchmarkResult[], prompts: BenchmarkPrompt[]): {
    validated: boolean;
    issues: ValidationIssue[];
    confidence: 'high' | 'medium' | 'low';
  } {
    const issues: ValidationIssue[] = [];

    // Stage 1: Correctness validation (per result)
    for (const result of results) {
      if (result.tokensPerSecond <= 0) {
        issues.push({ severity: 'error', stage: 'correctness', message: `Run ${result.run} for ${result.kvCacheType}/${result.prompt}: tokensPerSecond is 0 (Ollama error?)`, run: result.run, value: result.tokensPerSecond });
      }
      if (result.evalCount <= 0) {
        issues.push({ severity: 'error', stage: 'correctness', message: `Run ${result.run} for ${result.kvCacheType}/${result.prompt}: evalCount is 0 (no tokens generated)`, run: result.run });
      }
      if (result.totalDurationMs <= 0) {
        issues.push({ severity: 'error', stage: 'correctness', message: `Run ${result.run} for ${result.kvCacheType}/${result.prompt}: totalDurationMs is 0 (timing error)`, run: result.run });
      }
      const prompt = prompts.find(p => p.label === result.prompt);
      if (prompt && result.evalCount < prompt.expectedTokens * 0.3) {
        issues.push({ severity: 'warning', stage: 'correctness', message: `Run ${result.run} for ${result.kvCacheType}/${result.prompt}: evalCount (${result.evalCount}) is much lower than expected (${prompt.expectedTokens})`, run: result.run, value: result.evalCount });
      }
    }

    // Stage 2: Performance validation (per configuration)
    const kvTypes = [...new Set(results.map(r => r.kvCacheType))];
    for (const kvType of kvTypes) {
      const kvResults = results.filter(r => r.kvCacheType === kvType);
      if (kvResults.length < 2) continue;

      const tpsValues = kvResults.map(r => r.tokensPerSecond);
      const mean = tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length;
      const variance = tpsValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / tpsValues.length;
      const stdDev = Math.sqrt(variance);
      const cv = mean > 0 ? (stdDev / mean) * 100 : 0;

      if (cv > 30) {
        issues.push({ severity: 'warning', stage: 'performance', message: `${kvType}: coefficient of variation is ${cv.toFixed(1)}% (>30% threshold) — results are inconsistent`, value: Math.round(cv) });
      }

      // Outlier detection
      for (const r of kvResults) {
        if (stdDev > 0 && Math.abs(r.tokensPerSecond - mean) > 2 * stdDev) {
          issues.push({ severity: 'warning', stage: 'performance', message: `${kvType} run ${r.run}: outlier detected (TPS ${r.tokensPerSecond} vs mean ${mean.toFixed(1)})`, run: r.run, value: r.tokensPerSecond });
        }
      }
    }

    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warning').length;
    let confidence: 'high' | 'medium' | 'low' = 'high';
    if (errors > 0) confidence = 'low';
    else if (warnings > 2) confidence = 'low';
    else if (warnings > 0) confidence = 'medium';

    return { validated: errors === 0, issues, confidence };
  }

  private buildSummaryItem(
    label: string,
    variable: string,
    variableValue: number | string,
    results: ExpandedBenchmarkResult[]
  ): ExpandedBenchmarkSummary['summary'][0] {
    const n = results.length || 1;
    const avgTps = average(results.map((r) => r.tokensPerSecond));
    const avgTotal = results.reduce((s, r) => s + r.totalDurationMs, 0) / n;
    const avgEval = results.reduce((s, r) => s + r.evalDurationMs, 0) / n;
    const avgPromptEval = results.reduce((s, r) => {
      const dur = r.promptEvalDurationMs || 1;
      return s + (r.promptEvalCount / (dur / 1000));
    }, 0) / n;

    return {
      label,
      variable,
      variableValue,
      avgTokensPerSecond: Math.round(avgTps * 100) / 100,
      avgTotalDurationMs: Math.round(avgTotal),
      avgEvalDurationMs: Math.round(avgEval),
      avgPromptEvalTps: Math.round(avgPromptEval * 100) / 100,
      totalRuns: results.length,
    };
  }

  private async runSingle(
    model: string,
    prompt: BenchmarkPrompt,
    options?: Record<string, unknown>
  ): Promise<BenchmarkResult> {
    const response: GenerateResponse = await ollama.generate({
      model,
      prompt: prompt.text,
      stream: false,
      options,
    });

    const totalDurationMs = (response.total_duration || 0) / 1_000_000;
    const loadDurationMs = (response.load_duration || 0) / 1_000_000;
    const promptEvalDurationMs = (response.prompt_eval_duration || 0) / 1_000_000;
    const evalDurationMs = (response.eval_duration || 0) / 1_000_000;
    const evalCount = response.eval_count || 0;
    const tokensPerSecond = evalDurationMs > 0 ? evalCount / (evalDurationMs / 1000) : 0;

    return {
      model,
      kvCacheType: 'current',
      prompt: prompt.label,
      run: 0,
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

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function setExpandedParameter(
  result: ExpandedBenchmarkResult,
  key: ExpandedParameterKey,
  value: number
): void {
  result[key] = value;
}

export const benchmark = new BenchmarkService();
