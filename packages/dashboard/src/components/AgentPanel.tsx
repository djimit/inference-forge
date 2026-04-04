import React, { useState, useEffect, useRef } from 'react';
import { useOllama } from '../hooks/useOllama';

interface Agent {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  priority: string;
  enabled: boolean;
  sessions?: number;
  activeRequests?: number;
}

interface Session {
  id: string;
  agentId: string;
  status: string;
  messages: Array<{ role: string; content: string; timestamp: number }>;
}

interface AgentPanelProps {
  models: Array<{ name: string }>;
}

export function AgentPanel({ models }: AgentPanelProps) {
  const { apiCall, loading } = useOllama();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [newAgent, setNewAgent] = useState({
    name: '', model: '', systemPrompt: '', priority: 'medium' as string,
  });
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { loadAgents(); loadSessions(); }, []);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [activeSession?.messages]);

  const loadAgents = async () => {
    const res = await apiCall<{ agents: Agent[] }>('/agents');
    if (res) setAgents(res.agents);
  };

  const loadSessions = async () => {
    const res = await apiCall<{ sessions: Session[] }>('/sessions');
    if (res) setSessions(res.sessions);
  };

  const handleCreateAgent = async () => {
    if (!newAgent.name || !newAgent.model) return;
    await apiCall('/agents', {
      method: 'POST',
      body: JSON.stringify({
        id: `agent-${Date.now()}`,
        ...newAgent,
        temperature: 0.7,
        maxTokens: 2048,
        resourceLimits: { maxVramMb: 8192, maxContextTokens: 4096, maxConcurrentRequests: 2 },
        routing: [],
        enabled: true,
        createdAt: Date.now(),
      }),
    });
    setCreating(false);
    setNewAgent({ name: '', model: '', systemPrompt: '', priority: 'medium' });
    loadAgents();
  };

  const handleNewSession = async (agentId: string) => {
    const res = await apiCall<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    });
    if (res) {
      setActiveSession(res);
      loadSessions();
    }
  };

  const handleSend = async () => {
    if (!activeSession || !message.trim()) return;
    const msg = message;
    setMessage('');

    // Optimistically add user message
    setActiveSession((prev) => prev ? {
      ...prev,
      messages: [...prev.messages, { role: 'user', content: msg, timestamp: Date.now() }],
    } : prev);

    const res = await apiCall<{ response: string }>(`/sessions/${activeSession.id}/message`, {
      method: 'POST',
      body: JSON.stringify({ content: msg }),
    });

    if (res) {
      setActiveSession((prev) => prev ? {
        ...prev,
        messages: [...prev.messages, { role: 'assistant', content: res.response, timestamp: Date.now() }],
      } : prev);
    }
  };

  return (
    <div className="grid grid-cols-3 gap-6 h-[600px]">
      {/* Agent List */}
      <div className="bg-forge-card border border-forge-border rounded-xl p-4 overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">Agents</h2>
          <button
            onClick={() => setCreating(!creating)}
            className="text-xs px-2 py-1 bg-forge-accent text-white rounded-md hover:bg-indigo-500 transition-colors"
          >
            + New
          </button>
        </div>

        {creating && (
          <div className="mb-4 p-3 bg-forge-bg rounded-lg space-y-2">
            <input value={newAgent.name} onChange={(e) => setNewAgent({ ...newAgent, name: e.target.value })}
              placeholder="Agent name" className="w-full bg-forge-card border border-forge-border rounded px-2 py-1 text-sm text-forge-text" />
            <select value={newAgent.model} onChange={(e) => setNewAgent({ ...newAgent, model: e.target.value })}
              className="w-full bg-forge-card border border-forge-border rounded px-2 py-1 text-sm text-forge-text">
              <option value="">Select model...</option>
              {models.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
            <textarea value={newAgent.systemPrompt} onChange={(e) => setNewAgent({ ...newAgent, systemPrompt: e.target.value })}
              placeholder="System prompt..." rows={3}
              className="w-full bg-forge-card border border-forge-border rounded px-2 py-1 text-sm text-forge-text resize-none" />
            <button onClick={handleCreateAgent} disabled={!newAgent.name || !newAgent.model}
              className="w-full py-1 bg-forge-success text-white rounded text-sm disabled:opacity-50">
              Create Agent
            </button>
          </div>
        )}

        <div className="space-y-2">
          {agents.map((agent) => (
            <div key={agent.id} className="p-3 bg-forge-bg rounded-lg">
              <div className="flex justify-between items-center">
                <span className="font-medium text-sm">{agent.name}</span>
                <div className={`w-2 h-2 rounded-full ${agent.enabled ? 'bg-forge-success' : 'bg-forge-muted'}`} />
              </div>
              <div className="text-xs text-forge-muted mt-1">{agent.model}</div>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => handleNewSession(agent.id)}
                  className="text-xs px-2 py-0.5 bg-forge-accent/20 text-forge-accent rounded hover:bg-forge-accent/30 transition-colors"
                >
                  New Session
                </button>
                <span className="text-xs text-forge-muted py-0.5">
                  {agent.sessions || 0} sessions
                </span>
              </div>
            </div>
          ))}
          {agents.length === 0 && !creating && (
            <p className="text-forge-muted text-sm text-center py-4">No agents yet</p>
          )}
        </div>
      </div>

      {/* Chat Area */}
      <div className="col-span-2 bg-forge-card border border-forge-border rounded-xl flex flex-col">
        {activeSession ? (
          <>
            <div className="p-4 border-b border-forge-border">
              <span className="text-sm font-medium">
                Session: {activeSession.id.slice(0, 20)}...
              </span>
              <span className="text-xs text-forge-muted ml-2">
                ({activeSession.messages.length} messages)
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {activeSession.messages.filter((m) => m.role !== 'system').map((msg, idx) => (
                <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-lg p-3 text-sm ${
                    msg.role === 'user'
                      ? 'bg-forge-accent text-white'
                      : 'bg-forge-bg text-forge-text'
                  }`}>
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                    <div className="text-xs opacity-50 mt-1">
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="p-4 border-t border-forge-border flex gap-2">
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                placeholder="Type a message..."
                className="flex-1 bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-sm text-forge-text"
              />
              <button
                onClick={handleSend}
                disabled={!message.trim() || loading}
                className="px-4 py-2 bg-forge-accent text-white rounded-lg text-sm font-medium hover:bg-indigo-500 disabled:opacity-50 transition-colors"
              >
                Send
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-forge-muted text-sm">
            Select an agent and start a session to begin chatting
          </div>
        )}
      </div>
    </div>
  );
}
