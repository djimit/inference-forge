/**
 * Model Orchestrator
 * Manages concurrent model instances, agent workflows, routing, and resource allocation.
 */

import { ollama, type RunningModel } from './ollama.js';

export class ResourceLimitError extends Error {
  constructor(
    message: string,
    public agentId: string,
    public retryAfterMs: number,
    public currentUsage: { vramMb: number; contextTokens: number; concurrentRequests: number }
  ) {
    super(message);
    this.name = 'ResourceLimitError';
  }
}

// -- Types ----------------------------------------------------------

export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
  resourceLimits: {
    maxVramMb: number;
    maxContextTokens: number;
    maxConcurrentRequests: number;
  };
  routing: RoutingRule[];
  enabled: boolean;
  createdAt: number;
}

export interface RoutingRule {
  id: string;
  condition: 'keyword' | 'category' | 'length' | 'fallback';
  pattern?: string;        // regex for keyword, category name, or token threshold
  targetAgentId: string;
  priority: number;
}

export interface AgentSession {
  id: string;
  agentId: string;
  status: 'idle' | 'processing' | 'waiting' | 'error';
  messages: ConversationMessage[];
  createdAt: number;
  lastActivityAt: number;
  tokenCount: number;
  metadata: Record<string, unknown>;
}

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
  tokenCount?: number;
  durationMs?: number;
  model?: string;
}

export interface WorkflowStep {
  id: string;
  agentId: string;
  action: 'generate' | 'route' | 'transform' | 'aggregate' | 'conditional';
  config: Record<string, unknown>;
  nextSteps: string[];       // IDs of next steps
  errorStep?: string;        // ID of error handler step
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  entryStepId: string;
  createdAt: number;
  enabled: boolean;
}

export interface ResourceAllocation {
  agentId: string;
  model: string;
  allocatedVramMb: number;
  allocatedContextTokens: number;
  currentRequests: number;
  priority: number;
}

export interface OrchestratorStatus {
  timestamp: number;
  agents: Array<AgentConfig & { sessions: number; activeRequests: number }>;
  workflows: Workflow[];
  allocations: ResourceAllocation[];
  totalVramAllocatedMb: number;
  totalVramAvailableMb: number;
  activeSessionCount: number;
  queueDepth: number;
}

// -- Orchestrator ---------------------------------------------------

interface QueueItem {
  sessionId: string;
  message: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  enqueuedAt: number;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
}

export class OrchestratorService {
  private agents: Map<string, AgentConfig> = new Map();
  private sessions: Map<string, AgentSession> = new Map();
  private workflows: Map<string, Workflow> = new Map();
  private requestQueue: QueueItem[] = [];
  private processing = false;
  private queueProcessorInterval: ReturnType<typeof setInterval> | null = null;

  // -- Agent Management -------------------------------------------

  registerAgent(config: AgentConfig): void {
    this.agents.set(config.id, config);
    console.log(`[Orchestrator] Registered agent: ${config.name} (${config.model})`);
  }

  unregisterAgent(id: string): boolean {
    // Close all sessions for this agent
    for (const [sessionId, session] of this.sessions) {
      if (session.agentId === id) {
        this.sessions.delete(sessionId);
      }
    }
    return this.agents.delete(id);
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  getAllAgents(): AgentConfig[] {
    return [...this.agents.values()];
  }

  updateAgent(id: string, updates: Partial<AgentConfig>): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    this.agents.set(id, { ...agent, ...updates });
    return true;
  }

  // -- Session Management -----------------------------------------

  createSession(agentId: string): AgentSession {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const session: AgentSession = {
      id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      status: 'idle',
      messages: [
        {
          role: 'system',
          content: agent.systemPrompt,
          timestamp: Date.now(),
        },
      ],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      tokenCount: 0,
      metadata: {},
    };

    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): AgentSession[] {
    return [...this.sessions.values()];
  }

  getSessionsForAgent(agentId: string): AgentSession[] {
    return [...this.sessions.values()].filter((s) => s.agentId === agentId);
  }

  closeSession(id: string): boolean {
    return this.sessions.delete(id);
  }

  // -- Resource Management ---------------------------------------

  checkResourceLimits(agentId: string): {
    allowed: boolean;
    reason?: string;
    retryAfterMs?: number;
    currentUsage: { vramMb: number; contextTokens: number; concurrentRequests: number };
  } {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { allowed: false, reason: 'Agent not found', currentUsage: { vramMb: 0, contextTokens: 0, concurrentRequests: 0 } };
    }

    const activeSessions = this.getSessionsForAgent(agentId).filter(s => s.status === 'processing');
    const concurrentRequests = activeSessions.length;
    const vramMb = 0; // Populated by getStatus() caller
    const contextTokens = agent.resourceLimits.maxContextTokens;

    if (concurrentRequests >= agent.resourceLimits.maxConcurrentRequests) {
      return {
        allowed: false,
        reason: `Max concurrent requests (${agent.resourceLimits.maxConcurrentRequests}) exceeded`,
        retryAfterMs: 5000,
        currentUsage: { vramMb, contextTokens, concurrentRequests },
      };
    }

    return {
      allowed: true,
      currentUsage: { vramMb, contextTokens, concurrentRequests },
    };
  }

  // -- Message Handling -------------------------------------------

  async sendMessage(sessionId: string, content: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const agent = this.agents.get(session.agentId);
    if (!agent || !agent.enabled) throw new Error('Agent not available');

    // Resource limit enforcement
    const limits = this.checkResourceLimits(session.agentId);
    if (!limits.allowed) {
      throw new ResourceLimitError(
        limits.reason || 'Resource limit exceeded',
        session.agentId,
        limits.retryAfterMs || 5000,
        limits.currentUsage
      );
    }

    // Add user message
    session.messages.push({
      role: 'user',
      content,
      timestamp: Date.now(),
    });
    session.status = 'processing';
    session.lastActivityAt = Date.now();

    try {
      // Build messages array for chat API
      const messages = session.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await fetch(`${ollama.getBaseUrl()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: agent.model,
          messages,
          stream: false,
          options: {
            temperature: agent.temperature,
            num_predict: agent.maxTokens,
          },
        }),
      });

      if (!response.ok) throw new Error(`Chat API error: ${response.status}`);
      const data = await response.json() as any;

      const assistantContent = data.message?.content || '';
      const durationMs = (data.total_duration || 0) / 1_000_000;

      // Add assistant message
      session.messages.push({
        role: 'assistant',
        content: assistantContent,
        timestamp: Date.now(),
        tokenCount: data.eval_count,
        durationMs,
        model: agent.model,
      });

      session.tokenCount += (data.eval_count || 0) + (data.prompt_eval_count || 0);
      session.status = 'idle';
      session.lastActivityAt = Date.now();

      return assistantContent;
    } catch (err) {
      session.status = 'error';
      throw err;
    }
  }

  /**
   * Stream a message response token-by-token via callback.
   * Falls back to non-streaming on error.
   */
  async sendMessageStream(
    sessionId: string,
    content: string,
    onToken: (token: string) => void,
    onDone: (fullResponse: string) => void,
    onError: (err: Error) => void
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) { onError(new Error(`Session not found: ${sessionId}`)); return; }

    const agent = this.agents.get(session.agentId);
    if (!agent || !agent.enabled) { onError(new Error('Agent not available')); return; }

    session.messages.push({ role: 'user', content, timestamp: Date.now() });
    session.status = 'processing';
    session.lastActivityAt = Date.now();

    try {
      const messages = session.messages.map((m) => ({ role: m.role, content: m.content }));

      const response = await fetch(`${ollama.getBaseUrl()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: agent.model,
          messages,
          stream: true,
          options: { temperature: agent.temperature, num_predict: agent.maxTokens },
        }),
      });

      if (!response.ok || !response.body) throw new Error(`Chat API error: ${response.status}`);

      let fullContent = '';
      let evalCount = 0;
      let totalDuration = 0;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            if (chunk.message?.content) {
              fullContent += chunk.message.content;
              onToken(chunk.message.content);
            }
            if (chunk.done) {
              evalCount = chunk.eval_count || 0;
              totalDuration = chunk.total_duration || 0;
            }
          } catch { /* skip malformed line */ }
        }
      }

      session.messages.push({
        role: 'assistant',
        content: fullContent,
        timestamp: Date.now(),
        tokenCount: evalCount,
        durationMs: totalDuration / 1_000_000,
        model: agent.model,
      });

      session.tokenCount += evalCount;
      session.status = 'idle';
      session.lastActivityAt = Date.now();
      onDone(fullContent);
    } catch (err) {
      session.status = 'error';
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // -- Routing ----------------------------------------------------

  routeMessage(content: string): AgentConfig | null {
    const allRules: Array<RoutingRule & { agent: AgentConfig }> = [];

    for (const agent of this.agents.values()) {
      if (!agent.enabled) continue;
      for (const rule of agent.routing) {
        allRules.push({ ...rule, agent });
      }
    }

    // Sort by priority (higher first)
    allRules.sort((a, b) => b.priority - a.priority);

    for (const rule of allRules) {
      switch (rule.condition) {
        case 'keyword':
          if (rule.pattern && new RegExp(rule.pattern, 'i').test(content)) {
            return rule.agent;
          }
          break;
        case 'category':
          // Simple category detection
          if (rule.pattern && content.toLowerCase().includes(rule.pattern.toLowerCase())) {
            return rule.agent;
          }
          break;
        case 'length': {
          const threshold = parseInt(rule.pattern || '0', 10);
          if (content.length > threshold) return rule.agent;
          break;
        }
        case 'fallback':
          return rule.agent;
      }
    }

    return null;
  }

  routeMessageWithFallback(content: string): {
    agent: AgentConfig | null;
    method: 'rule' | 'advisor' | 'fallback' | 'none';
    confidence: number;
  } {
    // Stage 1: Exact rule match
    const ruleMatch = this.routeMessage(content);
    if (ruleMatch) {
      return { agent: ruleMatch, method: 'rule', confidence: 1.0 };
    }

    // Stage 2: Find fallback agent
    for (const agent of this.agents.values()) {
      if (!agent.enabled) continue;
      const hasFallback = agent.routing.some(r => r.condition === 'fallback');
      if (hasFallback) {
        return { agent, method: 'fallback', confidence: 0.5 };
      }
    }

    // Stage 3: No match at all
    return { agent: null, method: 'none', confidence: 0 };
  }

  // -- Workflow Execution -----------------------------------------

  registerWorkflow(workflow: Workflow): void {
    this.workflows.set(workflow.id, workflow);
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  getAllWorkflows(): Workflow[] {
    return [...this.workflows.values()];
  }

  async executeWorkflow(workflowId: string, input: string): Promise<string[]> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow || !workflow.enabled) throw new Error('Workflow not available');

    const results: string[] = [];
    const stepResults: Record<string, string> = {};
    let currentStepId = workflow.entryStepId;

    while (currentStepId) {
      const step = workflow.steps.find((s) => s.id === currentStepId);
      if (!step) break;

      try {
        const stepInput = results.length > 0 ? results[results.length - 1] : input;
        let result = '';

        switch (step.action) {
          case 'generate': {
            const session = this.createSession(step.agentId);
            result = await this.sendMessage(session.id, stepInput);
            this.closeSession(session.id);
            break;
          }
          case 'transform': {
            const template = (step.config.template as string) || '{{input}}';
            result = template.replace('{{input}}', stepInput);
            break;
          }
          case 'aggregate': {
            const separator = (step.config.separator as string) || '\n\n';
            result = results.join(separator);
            break;
          }
          case 'conditional': {
            const condPattern = (step.config.pattern as string) || '';
            const matches = new RegExp(condPattern, 'i').test(stepInput);
            currentStepId = matches
              ? (step.config.trueStep as string)
              : (step.config.falseStep as string);
            continue;
          }
          case 'route': {
            const agent = this.routeMessage(stepInput);
            if (agent) {
              const session = this.createSession(agent.id);
              result = await this.sendMessage(session.id, stepInput);
              this.closeSession(session.id);
            }
            break;
          }
        }

        stepResults[step.id] = result;
        results.push(result);
        currentStepId = step.nextSteps[0] || '';
      } catch (err) {
        if (step.errorStep) {
          currentStepId = step.errorStep;
        } else {
          throw err;
        }
      }
    }

    return results;
  }

  // -- Resource Allocation ----------------------------------------

  async getAllocations(): Promise<ResourceAllocation[]> {
    const running = await ollama.listRunning();
    const runningMap = new Map<string, RunningModel>();
    for (const m of running) {
      runningMap.set(m.name, m);
    }

    const allocations: ResourceAllocation[] = [];

    for (const agent of this.agents.values()) {
      if (!agent.enabled) continue;

      const runningModel = runningMap.get(agent.model);
      const activeSessions = this.getSessionsForAgent(agent.id)
        .filter((s) => s.status === 'processing');

      allocations.push({
        agentId: agent.id,
        model: agent.model,
        allocatedVramMb: runningModel ? runningModel.size_vram / (1024 * 1024) : 0,
        allocatedContextTokens: agent.resourceLimits.maxContextTokens,
        currentRequests: activeSessions.length,
        priority: agent.priority === 'critical' ? 4 : agent.priority === 'high' ? 3 : agent.priority === 'medium' ? 2 : 1,
      });
    }

    return allocations;
  }

  async getStatus(): Promise<OrchestratorStatus> {
    const allocations = await this.getAllocations();

    return {
      timestamp: Date.now(),
      agents: this.getAllAgents().map((a) => ({
        ...a,
        sessions: this.getSessionsForAgent(a.id).length,
        activeRequests: this.getSessionsForAgent(a.id).filter((s) => s.status === 'processing').length,
      })),
      workflows: this.getAllWorkflows(),
      allocations,
      totalVramAllocatedMb: allocations.reduce((sum, a) => sum + a.allocatedVramMb, 0),
      totalVramAvailableMb: 0, // filled by caller from hardware service
      activeSessionCount: [...this.sessions.values()].filter((s) => s.status !== 'idle').length,
      queueDepth: this.requestQueue.length,
    };
  }

  // -- Queue Management -------------------------------------------

  enqueueMessage(
    sessionId: string,
    message: string,
    priority: 'low' | 'medium' | 'high' | 'critical' = 'medium'
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.requestQueue.push({
        sessionId,
        message,
        priority,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      });
      // Sort by priority (higher first)
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      this.requestQueue.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
    });
  }

  getQueueStatus(): {
    depth: number;
    oldestMessageMs: number;
    byPriority: Record<string, number>;
  } {
    const now = Date.now();
    const byPriority: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const item of this.requestQueue) {
      byPriority[item.priority]++;
    }
    const oldest = this.requestQueue.length > 0
      ? now - Math.min(...this.requestQueue.map(i => i.enqueuedAt))
      : 0;
    return { depth: this.requestQueue.length, oldestMessageMs: oldest, byPriority };
  }

  startQueueProcessor(intervalMs = 5000): void {
    if (this.queueProcessorInterval) return;
    this.queueProcessorInterval = setInterval(() => {
      this.processQueue();
    }, intervalMs);
  }

  stopQueueProcessor(): void {
    if (this.queueProcessorInterval) {
      clearInterval(this.queueProcessorInterval);
      this.queueProcessorInterval = null;
    }
  }

  private async processQueue(): Promise<void> {
    if (this.requestQueue.length === 0) return;

    const now = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    // Reject timed-out messages
    const timedOut = this.requestQueue.filter(i => now - i.enqueuedAt > TIMEOUT_MS);
    for (const item of timedOut) {
      item.reject(new Error('Queue timeout: message waited too long'));
    }
    this.requestQueue = this.requestQueue.filter(i => now - i.enqueuedAt <= TIMEOUT_MS);

    // Process next item if resources available
    if (this.requestQueue.length === 0) return;
    const next = this.requestQueue[0];
    const session = this.sessions.get(next.sessionId);
    if (!session) {
      this.requestQueue.shift();
      next.reject(new Error('Session not found'));
      return;
    }

    const limits = this.checkResourceLimits(session.agentId);
    if (!limits.allowed) {
      return; // Wait for next interval
    }

    this.requestQueue.shift();
    try {
      const result = await this.sendMessage(next.sessionId, next.message);
      next.resolve(result);
    } catch (err) {
      next.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export const orchestrator = new OrchestratorService();
