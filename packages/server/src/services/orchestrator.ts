/**
 * Model Orchestrator
 * Manages concurrent model instances, agent workflows, routing, and resource allocation.
 */

import { ollama, type RunningModel } from './ollama.js';

// ── Types ──────────────────────────────────────────────────────────

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

// ── Orchestrator ───────────────────────────────────────────────────

export class OrchestratorService {
  private agents: Map<string, AgentConfig> = new Map();
  private sessions: Map<string, AgentSession> = new Map();
  private workflows: Map<string, Workflow> = new Map();
  private requestQueue: Array<{
    sessionId: string;
    message: string;
    resolve: (value: string) => void;
    reject: (reason: Error) => void;
  }> = [];
  private processing = false;

  // ── Agent Management ───────────────────────────────────────────

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

  // ── Session Management ─────────────────────────────────────────

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

  // ── Message Handling ───────────────────────────────────────────

  async sendMessage(sessionId: string, content: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const agent = this.agents.get(session.agentId);
    if (!agent || !agent.enabled) throw new Error('Agent not available');

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

  // ── Routing ────────────────────────────────────────────────────

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

  // ── Workflow Execution ─────────────────────────────────────────

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

  // ── Resource Allocation ────────────────────────────────────────

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
}

export const orchestrator = new OrchestratorService();
