import type { BenchmarkSummary, ExpandedBenchmarkSummary } from './benchmark.js';

class BenchmarkStateService {
  private lastBenchmarkResult: BenchmarkSummary | ExpandedBenchmarkSummary | null = null;
  private lastExpandedBenchmarkResult: ExpandedBenchmarkSummary | null = null;

  setBenchmarkResult(result: BenchmarkSummary | ExpandedBenchmarkSummary): void {
    this.lastBenchmarkResult = result;
  }

  getBenchmarkResult(): BenchmarkSummary | ExpandedBenchmarkSummary | null {
    return this.lastBenchmarkResult;
  }

  setExpandedBenchmarkResult(result: ExpandedBenchmarkSummary): void {
    this.lastExpandedBenchmarkResult = result;
    this.setBenchmarkResult(result);
  }

  getExpandedBenchmarkResult(): ExpandedBenchmarkSummary | null {
    return this.lastExpandedBenchmarkResult;
  }
}

export const benchmarkState = new BenchmarkStateService();
