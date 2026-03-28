/**
 * Custom Prompt Library
 * Manages benchmark prompt sets with configurable parameters.
 */

export interface PromptSet {
  id: string;
  name: string;
  description: string;
  author: string;
  createdAt: number;
  prompts: CustomPrompt[];
  config: RunConfig;
}

export interface CustomPrompt {
  id: string;
  label: string;
  category: 'short' | 'medium' | 'long' | 'stress-test' | 'custom';
  text: string;
  expectedTokens: number;
  systemPrompt?: string;
  tags: string[];
}

export interface RunConfig {
  runs: number;                  // repetitions per config
  warmupRuns: number;            // discard first N runs
  kvCacheTypes: string[];        // KV types to test
  temperatures: number[];        // temperature values to test
  contextSizes: number[];        // num_ctx values to test
  cooldownMs: number;            // pause between runs
  collectLogProbs: boolean;      // attempt perplexity measurement
}

// -- Built-in Prompt Sets -------------------------------------------

const BUILTIN_SETS: PromptSet[] = [
  {
    id: 'standard',
    name: 'Standard Benchmark',
    description: 'Default benchmark suite: short, medium, and long prompts',
    author: 'Inference Forge',
    createdAt: Date.now(),
    prompts: [
      {
        id: 'std-short',
        label: 'Short Generation',
        category: 'short',
        text: 'Explain what a KV cache is in large language models in one paragraph.',
        expectedTokens: 100,
        tags: ['technical', 'short'],
      },
      {
        id: 'std-medium',
        label: 'Medium Technical',
        category: 'medium',
        text: `Write a detailed technical explanation of how transformer attention mechanisms work,
including multi-head attention, query-key-value projections, and the role of positional
encodings. Include specific mathematical formulations where relevant.`,
        expectedTokens: 500,
        tags: ['technical', 'medium'],
      },
      {
        id: 'std-long',
        label: 'Long Document',
        category: 'long',
        text: `You are a senior software architect writing a comprehensive design document.
Create a complete system design for a real-time monitoring dashboard that tracks
GPU utilization, memory allocation, model inference latency, and throughput metrics.
Include sections on: 1) System architecture with component descriptions,
2) Data flow and storage design, 3) API specifications, 4) Frontend component hierarchy,
5) Scalability considerations, 6) Security measures, 7) Deployment strategy.
Be thorough and specific with technology choices and trade-offs.`,
        expectedTokens: 1500,
        tags: ['technical', 'long', 'architecture'],
      },
    ],
    config: {
      runs: 2,
      warmupRuns: 1,
      kvCacheTypes: ['f16', 'q8_0', 'q4_0'],
      temperatures: [0],
      contextSizes: [2048],
      cooldownMs: 1000,
      collectLogProbs: false,
    },
  },
  {
    id: 'coding',
    name: 'Code Generation',
    description: 'Focused on code generation quality and speed',
    author: 'Inference Forge',
    createdAt: Date.now(),
    prompts: [
      {
        id: 'code-func',
        label: 'Function Implementation',
        category: 'short',
        text: 'Write a TypeScript function that implements a least-recently-used (LRU) cache with O(1) get and put operations. Include type annotations and JSDoc comments.',
        expectedTokens: 200,
        tags: ['code', 'typescript'],
      },
      {
        id: 'code-class',
        label: 'Class Design',
        category: 'medium',
        text: 'Design and implement a Python class for a thread-safe connection pool with configurable min/max connections, health checks, automatic reconnection, and idle timeout. Include comprehensive error handling and logging.',
        expectedTokens: 500,
        tags: ['code', 'python', 'concurrency'],
      },
      {
        id: 'code-system',
        label: 'Full Module',
        category: 'long',
        text: 'Write a complete Node.js module that implements a job queue with the following features: priority scheduling, retry with exponential backoff, dead letter queue, rate limiting, concurrent worker management, graceful shutdown, and event-based monitoring. Use TypeScript and include full type definitions.',
        expectedTokens: 1500,
        tags: ['code', 'typescript', 'system'],
      },
    ],
    config: {
      runs: 2,
      warmupRuns: 1,
      kvCacheTypes: ['f16', 'q8_0', 'q4_0'],
      temperatures: [0.2],
      contextSizes: [4096],
      cooldownMs: 1000,
      collectLogProbs: false,
    },
  },
  {
    id: 'stress',
    name: 'Stress Test',
    description: 'High-context stress testing for memory pressure evaluation',
    author: 'Inference Forge',
    createdAt: Date.now(),
    prompts: [
      {
        id: 'stress-context',
        label: 'Context Filling',
        category: 'stress-test',
        text: `Analyze the following data and provide a comprehensive summary with statistical insights.
${'The quick brown fox jumps over the lazy dog. '.repeat(100)}
Now provide a detailed analysis of the text above, including word frequency analysis,
sentence structure patterns, and readability metrics.`,
        expectedTokens: 500,
        tags: ['stress', 'context-length'],
      },
      {
        id: 'stress-multi-turn',
        label: 'Multi-turn Simulation',
        category: 'stress-test',
        text: `You are maintaining a complex conversation. Here is the history:
${'User: Tell me more about topic ' + Array.from({length: 20}, (_, i) => `${i + 1}.\nAssistant: Topic ${i + 1} involves various considerations including efficiency, scalability, and maintainability. Let me elaborate on each aspect in detail.\n`).join('')}
User: Now summarize all 20 topics concisely.`,
        expectedTokens: 800,
        tags: ['stress', 'multi-turn', 'memory'],
      },
    ],
    config: {
      runs: 1,
      warmupRuns: 0,
      kvCacheTypes: ['f16', 'q8_0', 'q4_0'],
      temperatures: [0],
      contextSizes: [8192, 16384],
      cooldownMs: 2000,
      collectLogProbs: false,
    },
  },
];

// -- Prompt Library Service -----------------------------------------

export class PromptLibrary {
  private sets: Map<string, PromptSet> = new Map();

  constructor() {
    for (const set of BUILTIN_SETS) {
      this.sets.set(set.id, set);
    }
  }

  getAll(): PromptSet[] {
    return [...this.sets.values()];
  }

  get(id: string): PromptSet | undefined {
    return this.sets.get(id);
  }

  add(set: PromptSet): void {
    this.sets.set(set.id, set);
  }

  update(id: string, updates: Partial<PromptSet>): boolean {
    const existing = this.sets.get(id);
    if (!existing) return false;
    this.sets.set(id, { ...existing, ...updates });
    return true;
  }

  delete(id: string): boolean {
    // Don't allow deleting built-in sets
    const set = this.sets.get(id);
    if (set && BUILTIN_SETS.find((s) => s.id === id)) return false;
    return this.sets.delete(id);
  }

  exportSet(id: string): string | null {
    const set = this.sets.get(id);
    if (!set) return null;
    return JSON.stringify(set, null, 2);
  }

  importSet(json: string): PromptSet {
    const set = JSON.parse(json) as PromptSet;
    set.id = `imported-${Date.now()}`;
    set.createdAt = Date.now();
    this.sets.set(set.id, set);
    return set;
  }
}

export const promptLibrary = new PromptLibrary();
