/**
 * Modelfile Library
 * Import/export Modelfile templates with a community gallery.
 */

import { ollama } from './ollama.js';

export interface ModelfileTemplate {
  id: string;
  name: string;
  description: string;
  author: string;
  tags: string[];
  baseModel: string;
  useCase: string;
  content: string;      // The Modelfile text
  parameters: Record<string, string | number>;
  createdAt: number;
  updatedAt: number;
  downloads: number;
  rating: number;
}

// ── Community Templates ────────────────────────────────────────────

const COMMUNITY_TEMPLATES: ModelfileTemplate[] = [
  {
    id: 'sovereign-analyst',
    name: 'Sovereign Data Analyst',
    description: 'Optimized for data analysis on local infrastructure — no cloud dependencies. Low temperature for accuracy, high context for large datasets.',
    author: 'Inference Forge',
    tags: ['analysis', 'data', 'sovereignty', 'enterprise'],
    baseModel: 'llama3.2:latest',
    useCase: 'analysis',
    content: `FROM llama3.2:latest

PARAMETER num_ctx 32768
PARAMETER temperature 0.1
PARAMETER top_p 0.9
PARAMETER top_k 20
PARAMETER repeat_penalty 1.0

SYSTEM """
You are a precise data analyst. Analyze data thoroughly with statistical rigor.
Present findings in structured formats with tables and metrics.
Always cite specific data points. Never fabricate data.
When uncertain, state confidence levels explicitly.
"""`,
    parameters: { num_ctx: 32768, temperature: 0.1, top_p: 0.9 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    downloads: 0,
    rating: 0,
  },
  {
    id: 'secure-coder',
    name: 'Security-Aware Coder',
    description: 'Code generation with built-in security awareness. Flags common vulnerabilities and applies secure-by-default patterns.',
    author: 'Inference Forge',
    tags: ['coding', 'security', 'enterprise'],
    baseModel: 'codellama:latest',
    useCase: 'coding',
    content: `FROM codellama:latest

PARAMETER num_ctx 16384
PARAMETER temperature 0.2
PARAMETER top_p 0.95
PARAMETER top_k 20
PARAMETER repeat_penalty 1.0

SYSTEM """
You are a security-conscious software engineer. Write clean, well-documented,
secure code. Always consider:
- Input validation and sanitization
- SQL injection prevention (parameterized queries)
- XSS prevention (output encoding)
- Authentication and authorization checks
- Secrets management (never hardcode credentials)
- OWASP Top 10 vulnerabilities
Flag potential security issues with [SECURITY] comments.
"""`,
    parameters: { num_ctx: 16384, temperature: 0.2, top_p: 0.95 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    downloads: 0,
    rating: 0,
  },
  {
    id: 'compliance-advisor',
    name: 'EU Compliance Advisor',
    description: 'Specialized in EU regulatory frameworks including GDPR, NIS2, EU AI Act, and BIO2. Structured output for governance documentation.',
    author: 'Inference Forge',
    tags: ['compliance', 'governance', 'EU', 'enterprise'],
    baseModel: 'llama3.2:latest',
    useCase: 'analysis',
    content: `FROM llama3.2:latest

PARAMETER num_ctx 16384
PARAMETER temperature 0.3
PARAMETER top_p 0.9
PARAMETER top_k 30
PARAMETER repeat_penalty 1.1

SYSTEM """
You are an EU regulatory compliance advisor specializing in digital governance.
Your expertise covers GDPR, NIS2 Directive, EU AI Act, and Dutch BIO2 framework.
Always:
- Reference specific articles and requirements
- Assess compliance risk levels (Low/Medium/High/Critical)
- Provide actionable remediation steps
- Consider Dutch public sector context
- Flag data sovereignty concerns for cloud services
Structure outputs with clear headings and compliance matrices.
"""`,
    parameters: { num_ctx: 16384, temperature: 0.3, top_p: 0.9 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    downloads: 0,
    rating: 0,
  },
  {
    id: 'agent-orchestrator',
    name: 'Agent Orchestrator',
    description: 'Low-temperature, structured-output model for multi-agent coordination and tool use.',
    author: 'Inference Forge',
    tags: ['agent', 'orchestration', 'tools'],
    baseModel: 'llama3.2:latest',
    useCase: 'agent',
    content: `FROM llama3.2:latest

PARAMETER num_ctx 8192
PARAMETER temperature 0.05
PARAMETER top_p 0.9
PARAMETER top_k 10
PARAMETER repeat_penalty 1.0

SYSTEM """
You are an AI agent orchestrator. Execute tasks precisely and deterministically.
Rules:
1. Parse instructions into discrete steps
2. Use available tools via structured JSON output
3. Report status after each step: {status: "success"|"error", result: ...}
4. Handle errors gracefully with retry logic
5. Never improvise — follow instructions exactly
6. Output structured JSON when tool use is required
"""`,
    parameters: { num_ctx: 8192, temperature: 0.05, top_p: 0.9 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    downloads: 0,
    rating: 0,
  },
  {
    id: 'creative-writer',
    name: 'Creative Writer',
    description: 'High-temperature creative writing with diverse vocabulary and narrative flair.',
    author: 'Inference Forge',
    tags: ['creative', 'writing', 'storytelling'],
    baseModel: 'llama3.2:latest',
    useCase: 'creative',
    content: `FROM llama3.2:latest

PARAMETER num_ctx 8192
PARAMETER temperature 0.9
PARAMETER top_p 0.95
PARAMETER top_k 60
PARAMETER repeat_penalty 1.2

SYSTEM """
You are a talented creative writer with a vivid imagination.
Write with engaging prose, varied sentence structure, and rich imagery.
Develop compelling characters and narratives.
Use sensory details and emotional depth. Avoid clichés.
"""`,
    parameters: { num_ctx: 8192, temperature: 0.9, top_p: 0.95 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    downloads: 0,
    rating: 0,
  },
];

// ── Library Service ────────────────────────────────────────────────

export class ModelfileLibrary {
  private templates: Map<string, ModelfileTemplate> = new Map();

  constructor() {
    for (const tmpl of COMMUNITY_TEMPLATES) {
      this.templates.set(tmpl.id, tmpl);
    }
  }

  getAll(): ModelfileTemplate[] {
    return [...this.templates.values()];
  }

  get(id: string): ModelfileTemplate | undefined {
    return this.templates.get(id);
  }

  search(query: string): ModelfileTemplate[] {
    const q = query.toLowerCase();
    return this.getAll().filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.includes(q)) ||
        t.useCase.includes(q)
    );
  }

  getByTag(tag: string): ModelfileTemplate[] {
    return this.getAll().filter((t) => t.tags.includes(tag));
  }

  add(template: ModelfileTemplate): void {
    this.templates.set(template.id, template);
  }

  update(id: string, updates: Partial<ModelfileTemplate>): boolean {
    const existing = this.templates.get(id);
    if (!existing) return false;
    this.templates.set(id, { ...existing, ...updates, updatedAt: Date.now() });
    return true;
  }

  delete(id: string): boolean {
    return this.templates.delete(id);
  }

  exportTemplate(id: string): string | null {
    const template = this.templates.get(id);
    if (!template) return null;
    return JSON.stringify(template, null, 2);
  }

  importTemplate(json: string): ModelfileTemplate {
    const template = JSON.parse(json) as ModelfileTemplate;
    template.id = `imported-${Date.now()}`;
    template.createdAt = Date.now();
    template.updatedAt = Date.now();
    this.templates.set(template.id, template);
    return template;
  }

  /**
   * Create a model in Ollama from a template.
   */
  async createModel(templateId: string, modelName: string): Promise<{ success: boolean; error?: string }> {
    const template = this.templates.get(templateId);
    if (!template) return { success: false, error: 'Template not found' };

    try {
      const response = await fetch(`${ollama.getBaseUrl()}/api/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: modelName,
          modelfile: template.content,
          stream: false,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        return { success: false, error };
      }

      template.downloads++;
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
}

export const modelfileLibrary = new ModelfileLibrary();
