import { describe, expect, it } from 'vitest';
import { OrchestratorService, type AgentConfig } from '../services/orchestrator.js';

const agent = (id: string, pattern: string): AgentConfig => ({
  id,
  name: id,
  model: 'test',
  systemPrompt: '',
  temperature: 0,
  maxTokens: 1,
  priority: 'low',
  resourceLimits: { maxVramMb: 1, maxContextTokens: 1, maxConcurrentRequests: 1 },
  routing: [{ id: 'rule', condition: 'keyword', pattern, targetAgentId: id, priority: 1 }],
  enabled: true,
  createdAt: 0,
});

describe('orchestrator routing security', () => {
  it('treats configured keywords as literals, not executable regular expressions', () => {
    const service = new OrchestratorService();
    service.registerAgent(agent('literal', 'a+'));

    expect(service.routeMessage('aaaa')).toBeNull();
    expect(service.routeMessage('contains A+ literally')?.id).toBe('literal');
  });
});
