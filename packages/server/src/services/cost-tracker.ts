/**
 * Cost Tracker Service
 * Tracks estimated API costs across providers by monitoring Ollama and estimating Anthropic usage.
 * Provides burn rate calculations for credit monitoring.
 */

import { database } from './database.js';

// -- Types ----------------------------------------------------------

export interface UsageSample {
  timestamp: number;
  provider: 'anthropic' | 'ollama' | 'openrouter' | 'google';
  model: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface CostSnapshot {
  timestamp: number;
  today: ProviderCost[];
  last7Days: ProviderCost[];
  last30Days: ProviderCost[];
  burnRatePerDay: number;
  estimatedDaysRemaining: number | null;
  creditDeadline: string;
}

export interface ProviderCost {
  provider: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  requestCount: number;
}

// -- Pricing (per million tokens, USD) --------------------------------

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 0.8, output: 4.0 },
  'gemini-2.0-flash': { input: 0.0, output: 0.0 }, // free tier
  'gpt-4o': { input: 2.5, output: 10.0 },
  // Local models are free (electricity only)
  'phi4': { input: 0.0, output: 0.0 },
  'mistral-small': { input: 0.0, output: 0.0 },
  'qwen2.5': { input: 0.0, output: 0.0 },
};

// -- Service --------------------------------------------------------

export class CostTracker {
  private samples: UsageSample[] = [];
  private creditBudgetUsd: number = 20.0; // Default estimate, can be updated
  private creditDeadline: string = '2026-04-17';

  recordUsage(sample: UsageSample): void {
    this.samples.push(sample);
    // Persist to SQLite
    database.saveAlert({
      id: `cost-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: sample.timestamp,
      severity: 'info',
      category: 'cost',
      title: `${sample.provider}/${sample.model}`,
      message: `${sample.inputTokens} in / ${sample.outputTokens} out = $${sample.estimatedCostUsd.toFixed(4)}`,
      model: sample.model,
      value: sample.estimatedCostUsd,
      threshold: null,
      acknowledged: false,
    });
  }

  estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
    // Normalize model name for pricing lookup
    const key = Object.keys(PRICING).find((k) => model.toLowerCase().includes(k)) || '';
    const pricing = PRICING[key];
    if (!pricing) return 0;

    return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  }

  setCreditBudget(usd: number): void {
    this.creditBudgetUsd = usd;
  }

  getSnapshot(): CostSnapshot {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    const todaySamples = this.samples.filter((s) => s.timestamp > now - dayMs);
    const week = this.samples.filter((s) => s.timestamp > now - 7 * dayMs);
    const month = this.samples.filter((s) => s.timestamp > now - 30 * dayMs);

    const aggregate = (samples: UsageSample[]): ProviderCost[] => {
      const byProvider: Record<string, ProviderCost> = {};
      for (const s of samples) {
        if (!byProvider[s.provider]) {
          byProvider[s.provider] = {
            provider: s.provider,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            estimatedCostUsd: 0,
            requestCount: 0,
          };
        }
        const p = byProvider[s.provider];
        p.totalInputTokens += s.inputTokens;
        p.totalOutputTokens += s.outputTokens;
        p.estimatedCostUsd += s.estimatedCostUsd;
        p.requestCount++;
      }
      return Object.values(byProvider);
    };

    const todayCosts = aggregate(todaySamples);
    const weekCosts = aggregate(week);

    // Calculate burn rate from last 7 days
    const totalWeekCost = weekCosts.reduce((s, c) => s + c.estimatedCostUsd, 0);
    const daysWithData = Math.max(1, Math.min(7, (now - Math.min(...week.map((s) => s.timestamp))) / dayMs));
    const burnRatePerDay = totalWeekCost / daysWithData;

    // Estimate days remaining on credit
    const totalSpent = this.samples
      .filter((s) => s.provider === 'anthropic')
      .reduce((s, c) => s + c.estimatedCostUsd, 0);
    const remaining = this.creditBudgetUsd - totalSpent;
    const estimatedDaysRemaining = burnRatePerDay > 0 ? remaining / burnRatePerDay : null;

    return {
      timestamp: now,
      today: todayCosts,
      last7Days: weekCosts,
      last30Days: aggregate(month),
      burnRatePerDay: Math.round(burnRatePerDay * 100) / 100,
      estimatedDaysRemaining: estimatedDaysRemaining !== null
        ? Math.round(estimatedDaysRemaining * 10) / 10
        : null,
      creditDeadline: this.creditDeadline,
    };
  }

  getSamples(limit = 100): UsageSample[] {
    return this.samples.slice(-limit);
  }
}

export const costTracker = new CostTracker();
