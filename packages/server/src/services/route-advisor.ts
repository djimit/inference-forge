/**
 * Intelligent Route Advisor
 * Recommends the best model+backend for a given task based on performance profiles,
 * current resource state, and configurable routing policies.
 */

import { perfProfiler, type ModelProfile } from './perf-profiler.js';
import { modelRegistry, type Backend } from './model-registry.js';
import { pressure } from './pressure.js';

// -- Types ----------------------------------------------------------

export type TaskType = 'chat' | 'coding' | 'analysis' | 'creative' | 'embedding' | 'reasoning';
export type QualityRequirement = 'fast' | 'balanced' | 'best';
export type LatencyBudget = 'realtime' | 'interactive' | 'batch';

export interface RouteRequest {
  taskType: TaskType;
  quality: QualityRequirement;
  latency: LatencyBudget;
  preferBackend?: Backend;
  excludeModels?: string[];
}

export interface RouteRecommendation {
  model: ModelProfile;
  score: number;          // 0-100 composite score
  reason: string;
  estimatedTokS: number;
  estimatedFirstTokenMs: number;
  warnings: string[];
}

export interface RoutingPolicy {
  id: string;
  name: string;
  description: string;
  rules: Array<{
    taskType?: TaskType;
    quality?: QualityRequirement;
    latency?: LatencyBudget;
    preferModel?: string;
    preferBackend?: Backend;
    weight: number;        // multiplier for scoring
  }>;
}

// -- Default Policies -----------------------------------------------

const DEFAULT_POLICIES: RoutingPolicy[] = [
  {
    id: 'gpu-for-interactive',
    name: 'GPU for Interactive',
    description: 'Prefer GPU-loaded models for real-time tasks',
    rules: [
      { latency: 'realtime', preferBackend: 'ollama', weight: 1.5 },
      { latency: 'interactive', preferBackend: 'ollama', weight: 1.2 },
    ],
  },
  {
    id: 'big-for-quality',
    name: 'Large Models for Quality',
    description: 'Route quality-critical tasks to largest available model',
    rules: [
      { quality: 'best', weight: 2.0 },
      { taskType: 'reasoning', quality: 'best', weight: 2.5 },
    ],
  },
  {
    id: 'coding-specialist',
    name: 'Coding Specialist',
    description: 'Prefer code-trained models for coding tasks',
    rules: [
      { taskType: 'coding', weight: 1.5 },
    ],
  },
];

// -- Latency Budgets (ms for first token) ---------------------------

const LATENCY_LIMITS: Record<LatencyBudget, number> = {
  realtime: 2000,    // < 2s first token
  interactive: 10000, // < 10s first token
  batch: Infinity,    // no limit
};

// -- Task-Architecture Affinity -------------------------------------

const TASK_ARCH_AFFINITY: Record<TaskType, string[]> = {
  coding: ['qwen3next', 'qwen3', 'gpt-oss', 'phi3', 'phi4'],
  reasoning: ['qwen3next', 'qwen3', 'gpt-oss'],
  analysis: ['qwen3next', 'qwen3', 'gpt-oss'],
  chat: ['phi3', 'phi4', 'gemma3', 'qwen3'],
  creative: ['gemma3', 'qwen3', 'phi3'],
  embedding: ['nomic-bert'],
};

// -- Service --------------------------------------------------------

export class RouteAdvisor {
  private policies: RoutingPolicy[] = [...DEFAULT_POLICIES];

  /** Get best model recommendation for a task */
  recommend(request: RouteRequest): RouteRecommendation[] {
    const profiles = perfProfiler.getProfiles();
    if (profiles.length === 0) {
      return [];
    }

    const latencyLimit = LATENCY_LIMITS[request.latency];
    const affinityArchs = TASK_ARCH_AFFINITY[request.taskType] || [];

    // Get current resource state
    const pressureState = pressure.getLastPressure();
    const registry = modelRegistry.getSnapshot();

    const candidates: RouteRecommendation[] = [];

    for (const profile of profiles) {
      // Skip excluded models
      if (request.excludeModels?.includes(profile.id)) continue;

      // Skip if backend preference doesn't match
      if (request.preferBackend && profile.backend !== request.preferBackend) continue;

      // Skip embedding models for non-embedding tasks
      if (request.taskType !== 'embedding' && profile.architecture === 'nomic-bert') continue;
      if (request.taskType === 'embedding' && profile.architecture !== 'nomic-bert') continue;

      const score = this.scoreModel(profile, request, affinityArchs, latencyLimit, pressureState);
      const warnings: string[] = [];

      // Check if model fits current resources
      const regModel = registry?.models.find((m) => m.id === profile.id);
      if (regModel && !regModel.loaded && pressureState) {
        if (profile.vramUsageMb && profile.vramUsageMb > (pressureState.vramTotalMb - pressureState.vramUsedMb)) {
          warnings.push('Will require model eviction or CPU fallback');
        }
      }

      // Estimate performance
      const tokS = profile.tokSGpu || profile.tokSCpu || 1;
      const firstToken = profile.firstTokenMs || (regModel?.loaded ? 100 : 5000);

      if (firstToken > latencyLimit && request.latency !== 'batch') {
        warnings.push(`First token (~${Math.round(firstToken)}ms) may exceed ${request.latency} budget`);
      }

      candidates.push({
        model: profile,
        score,
        reason: this.explainScore(profile, request, affinityArchs, score),
        estimatedTokS: Math.round(tokS * 100) / 100,
        estimatedFirstTokenMs: Math.round(firstToken),
        warnings,
      });
    }

    // Sort by score descending
    return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  /** Score a model for a given request (0-100) */
  private scoreModel(
    profile: ModelProfile,
    request: RouteRequest,
    affinityArchs: string[],
    latencyLimit: number,
    pressureState: any
  ): number {
    let score = 50; // baseline

    const tokS = profile.tokSGpu || profile.tokSCpu || 0;
    const quality = profile.qualityProxy || 0;
    const paramB = parseFloat(profile.parameterSize) || 0;

    // Speed scoring (0-25 points)
    if (request.quality === 'fast') {
      score += Math.min(25, tokS * 0.5); // fast tasks: speed matters most
    } else if (request.quality === 'balanced') {
      score += Math.min(15, tokS * 0.3);
    } else {
      score += Math.min(10, tokS * 0.2); // quality tasks: speed matters less
    }

    // Quality scoring (0-25 points)
    if (request.quality === 'best') {
      score += quality * 25;
      score += Math.min(15, paramB * 0.2); // larger models = generally better quality
    } else if (request.quality === 'balanced') {
      score += quality * 15;
    } else {
      score += quality * 5;
    }

    // Architecture affinity (0-15 points)
    if (affinityArchs.includes(profile.architecture)) {
      const rank = affinityArchs.indexOf(profile.architecture);
      score += Math.max(0, 15 - rank * 3);
    }

    // Already loaded bonus (big advantage for latency)
    const regModel = modelRegistry.getSnapshot()?.models.find((m) => m.id === profile.id);
    if (regModel?.loaded) {
      score += request.latency === 'realtime' ? 20 : request.latency === 'interactive' ? 10 : 2;
    }

    // Latency penalty
    const firstToken = profile.firstTokenMs || (regModel?.loaded ? 100 : 5000);
    if (firstToken > latencyLimit) {
      score -= 20;
    }

    // Tool use bonus for coding/agent tasks
    if ((request.taskType === 'coding' || request.taskType === 'reasoning') && regModel?.toolUse) {
      score += 10;
    }

    // Apply policy multipliers
    for (const policy of this.policies) {
      for (const rule of policy.rules) {
        if (rule.taskType && rule.taskType !== request.taskType) continue;
        if (rule.quality && rule.quality !== request.quality) continue;
        if (rule.latency && rule.latency !== request.latency) continue;
        if (rule.preferBackend && rule.preferBackend !== profile.backend) continue;

        score *= rule.weight;
      }
    }

    return Math.min(100, Math.max(0, Math.round(score)));
  }

  private explainScore(
    profile: ModelProfile,
    request: RouteRequest,
    affinityArchs: string[],
    score: number
  ): string {
    const parts: string[] = [];
    const tokS = profile.tokSGpu || profile.tokSCpu || 0;

    if (tokS > 20) parts.push(`fast (${tokS} tok/s)`);
    else if (tokS > 5) parts.push(`moderate (${tokS} tok/s)`);
    else parts.push(`slow (${tokS} tok/s)`);

    if (affinityArchs.includes(profile.architecture)) {
      parts.push(`${profile.architecture} suited for ${request.taskType}`);
    }

    const paramB = parseFloat(profile.parameterSize) || 0;
    if (paramB >= 70) parts.push('large model — highest quality');
    else if (paramB >= 20) parts.push('medium model — good balance');
    else parts.push('small model — fast response');

    return parts.join(', ');
  }

  // -- Policy Management --------------------------------------------

  getPolicies(): RoutingPolicy[] {
    return this.policies;
  }

  addPolicy(policy: RoutingPolicy): void {
    this.policies = this.policies.filter((p) => p.id !== policy.id);
    this.policies.push(policy);
  }

  removePolicy(id: string): boolean {
    const before = this.policies.length;
    this.policies = this.policies.filter((p) => p.id !== id);
    return this.policies.length < before;
  }
}

export const routeAdvisor = new RouteAdvisor();
