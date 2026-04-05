/**
 * OpenClaw Bridge Service
 * Connects Inference Forge's route advisor to OpenClaw's 14-agent gateway.
 * Provides model recommendations, agent cost attribution, and capacity queries.
 */

import { routeAdvisor, type RouteRequest, type TaskType, type QualityRequirement, type LatencyBudget } from './route-advisor.js';
import { modelRegistry } from './model-registry.js';
import { perfProfiler } from './perf-profiler.js';
import { pressure } from './pressure.js';
import { costTracker, type UsageSample } from './cost-tracker.js';

// -- Types ----------------------------------------------------------

export interface OpenClawAgent {
  id: string;
  name: string;
  model: string;
  role: string;
  totalTokens: number;
  totalRequests: number;
  estimatedCostUsd: number;
  lastActive: number | null;
}

export interface ModelRecommendation {
  agentId: string;
  currentModel: string;
  recommendedModel: string;
  recommendedBackend: string;
  reason: string;
  estimatedSpeedup: string;
  estimatedCostChange: string;
}

export interface CapacityResponse {
  canServe: boolean;
  model: string;
  backend: string;
  estimatedWaitMs: number;
  estimatedTokS: number;
  warnings: string[];
}

// -- OpenClaw Agent Registry ----------------------------------------

const OPENCLAW_AGENTS: Array<{ id: string; name: string; model: string; role: string }> = [
  { id: 'main', name: 'Main', model: 'anthropic/claude-opus-4-6', role: 'primary orchestrator' },
  { id: 'forge', name: 'Forge', model: 'anthropic/claude-sonnet-4-6', role: 'coding specialist' },
  { id: 'scout', name: 'Scout', model: 'ollama/phi4-opt', role: 'research & content' },
  { id: 'sentinel', name: 'Sentinel', model: 'ollama/phi4-opt', role: 'ops & monitoring' },
  { id: 'archon', name: 'Archon', model: 'ollama/phi4-opt', role: 'architecture' },
  { id: 'merchant', name: 'Merchant', model: 'ollama/phi4-opt', role: 'business & commerce' },
  { id: 'herald', name: 'Herald', model: 'ollama/phi4-opt', role: 'communication' },
  { id: 'guardian', name: 'Guardian', model: 'ollama/phi4-opt', role: 'security' },
  { id: 'sage', name: 'Sage', model: 'ollama/phi4-opt', role: 'knowledge' },
  { id: 'runner', name: 'Runner', model: 'ollama/phi4-opt', role: 'deployment' },
  { id: 'analyst', name: 'Analyst', model: 'ollama/phi4-opt', role: 'analytics' },
];

// -- Role → Task Type Mapping ---------------------------------------

const ROLE_TASK_MAP: Record<string, TaskType> = {
  'primary orchestrator': 'reasoning',
  'coding specialist': 'coding',
  'research & content': 'analysis',
  'ops & monitoring': 'chat',
  'architecture': 'reasoning',
  'business & commerce': 'chat',
  'communication': 'creative',
  'security': 'analysis',
  'knowledge': 'analysis',
  'deployment': 'coding',
  'analytics': 'analysis',
};

// -- Service --------------------------------------------------------

export class OpenClawBridge {
  private agentUsage: Map<string, { tokens: number; requests: number; costUsd: number; lastActive: number }> = new Map();

  /** Get all agents with their usage stats */
  getAgents(): OpenClawAgent[] {
    return OPENCLAW_AGENTS.map((a) => {
      const usage = this.agentUsage.get(a.id);
      return {
        ...a,
        totalTokens: usage?.tokens || 0,
        totalRequests: usage?.requests || 0,
        estimatedCostUsd: usage?.costUsd || 0,
        lastActive: usage?.lastActive || null,
      };
    });
  }

  /** Record usage from an OpenClaw agent */
  recordAgentUsage(agentId: string, tokens: number, costUsd: number): void {
    const existing = this.agentUsage.get(agentId) || { tokens: 0, requests: 0, costUsd: 0, lastActive: 0 };
    existing.tokens += tokens;
    existing.requests += 1;
    existing.costUsd += costUsd;
    existing.lastActive = Date.now();
    this.agentUsage.set(agentId, existing);

    // Also record in cost tracker
    const agent = OPENCLAW_AGENTS.find((a) => a.id === agentId);
    if (agent) {
      const provider = agent.model.startsWith('ollama/') ? 'ollama'
        : agent.model.startsWith('anthropic/') ? 'anthropic'
        : 'openrouter';

      costTracker.recordUsage({
        timestamp: Date.now(),
        provider: provider as any,
        model: agent.model.split('/').pop() || agent.model,
        agent: agentId,
        inputTokens: Math.floor(tokens * 0.6), // rough split
        outputTokens: Math.floor(tokens * 0.4),
        estimatedCostUsd: costUsd,
      });
    }
  }

  /** Check if a model can serve a request right now */
  checkCapacity(modelId: string): CapacityResponse {
    const registry = modelRegistry.getSnapshot();
    const model = registry?.models.find((m) =>
      m.backendModelId === modelId || m.id === modelId || m.name === modelId
    );

    if (!model) {
      return {
        canServe: false,
        model: modelId,
        backend: 'unknown',
        estimatedWaitMs: -1,
        estimatedTokS: 0,
        warnings: [`Model "${modelId}" not found in registry`],
      };
    }

    const profile = perfProfiler.getProfile(model.backend, model.backendModelId);
    const tokS = profile?.tokSGpu || profile?.tokSCpu || 0;
    const warnings: string[] = [];

    if (model.loaded) {
      return {
        canServe: true,
        model: model.backendModelId,
        backend: model.backend,
        estimatedWaitMs: profile?.firstTokenMs || 100,
        estimatedTokS: tokS,
        warnings,
      };
    }

    // Model not loaded — check if it can be loaded
    const pressureState = pressure.getLastPressure();
    if (pressureState && model.sizeMb > 0) {
      const freeMb = pressureState.vramTotalMb - pressureState.vramUsedMb;
      if (model.sizeMb > freeMb + (pressureState.ramTotalMb - pressureState.ramUsedMb)) {
        warnings.push('Insufficient memory — may cause swapping');
      } else if (model.sizeMb > freeMb) {
        warnings.push('Will use CPU/RAM split inference — slower tok/s');
      }
    }

    return {
      canServe: true,
      model: model.backendModelId,
      backend: model.backend,
      estimatedWaitMs: 5000 + (profile?.firstTokenMs || 2000), // load time + first token
      estimatedTokS: tokS,
      warnings,
    };
  }

  /** Get model recommendations for all agents based on performance profiles */
  getRecommendations(): ModelRecommendation[] {
    const recommendations: ModelRecommendation[] = [];

    for (const agent of OPENCLAW_AGENTS) {
      // Skip cloud-only agents (main, forge use Anthropic)
      if (!agent.model.startsWith('ollama/') && !agent.model.startsWith('lmstudio/')) continue;

      const taskType = ROLE_TASK_MAP[agent.role] || 'chat';
      const routeResult = routeAdvisor.recommend({
        taskType,
        quality: 'balanced',
        latency: 'interactive',
      });

      if (routeResult.length === 0) continue;

      const best = routeResult[0];
      const currentModelName = agent.model.replace(/^(ollama|lmstudio)\//, '');

      // Only recommend if different from current and meaningfully better
      if (best.model.modelId !== currentModelName && best.score > 60) {
        const currentProfile = perfProfiler.getProfile('ollama', currentModelName);
        const currentTokS = currentProfile?.tokSGpu || currentProfile?.tokSCpu || 0;
        const speedup = currentTokS > 0 ? best.estimatedTokS / currentTokS : 0;

        // Only recommend if >20% faster or >20% better quality
        if (speedup > 1.2 || (best.model.qualityProxy || 0) > ((currentProfile?.qualityProxy || 0) * 1.2)) {
          recommendations.push({
            agentId: agent.id,
            currentModel: agent.model,
            recommendedModel: best.model.modelId,
            recommendedBackend: best.model.backend,
            reason: best.reason,
            estimatedSpeedup: speedup > 1 ? `${Math.round((speedup - 1) * 100)}% faster` : 'similar speed',
            estimatedCostChange: best.model.backend === 'ollama' || best.model.backend === 'lmstudio' ? 'free (local)' : 'paid API',
          });
        }
      }
    }

    return recommendations;
  }

  /** Advise on best model for a specific agent's next task */
  adviseForAgent(agentId: string, taskDescription?: string): CapacityResponse & { recommendedModel?: string } {
    const agent = OPENCLAW_AGENTS.find((a) => a.id === agentId);
    if (!agent) {
      return {
        canServe: false,
        model: 'unknown',
        backend: 'unknown',
        estimatedWaitMs: -1,
        estimatedTokS: 0,
        warnings: [`Agent "${agentId}" not found`],
      };
    }

    // Check current model capacity
    const capacity = this.checkCapacity(agent.model);

    // If current model works fine, use it
    if (capacity.canServe && capacity.warnings.length === 0 && capacity.estimatedTokS > 5) {
      return capacity;
    }

    // Otherwise, find a better option
    const taskType = ROLE_TASK_MAP[agent.role] || 'chat';
    const results = routeAdvisor.recommend({
      taskType,
      quality: 'balanced',
      latency: 'interactive',
    });

    if (results.length > 0) {
      const best = results[0];
      return {
        ...capacity,
        recommendedModel: `${best.model.backend}/${best.model.modelId}`,
        warnings: [...capacity.warnings, `Consider: ${best.model.displayName} (${best.reason})`],
      };
    }

    return capacity;
  }
}

export const openclawBridge = new OpenClawBridge();
