/**
 * LM Studio Backend Client
 * OpenAI-compatible REST API on port 1234 + CLI control via `lms`.
 * Manages server lifecycle, model listing, loading, and generation.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// -- Types ----------------------------------------------------------

export interface LmsModel {
  type: 'llm' | 'embedding';
  modelKey: string;
  displayName: string;
  publisher: string;
  path: string;
  sizeBytes: number;
  paramsString: string;
  architecture: string;
  quantization: { name: string; bits: number } | null;
  variants: string[];
  selectedVariant: string;
  vision: boolean;
  trainedForToolUse: boolean;
  maxContextLength: number;
}

export interface LmsLoadedModel {
  identifier: string;
  path: string;
  sizeBytes?: number;
  architecture?: string;
  quantization?: string;
}

export interface LmsChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LmsChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface LmsGenerateResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    text: string;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// -- Client ---------------------------------------------------------

export class LmStudioClient {
  private baseUrl: string;
  private lmsBin: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.LMS_HOST || 'http://localhost:1234';
    this.lmsBin = 'lms';
  }

  // -- Server Lifecycle ---------------------------------------------

  async isServerRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async startServer(): Promise<boolean> {
    try {
      await execFileAsync(this.lmsBin, ['server', 'start'], { timeout: 15000 });
      // Wait for server to be ready
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await this.isServerRunning()) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async stopServer(): Promise<boolean> {
    try {
      await execFileAsync(this.lmsBin, ['server', 'stop'], { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  // -- Model Listing ------------------------------------------------

  /** List all models available on disk via CLI (rich metadata) */
  async listModelsDetailed(): Promise<LmsModel[]> {
    try {
      const { stdout } = await execFileAsync(this.lmsBin, ['ls', '--json'], { timeout: 10000 });
      return JSON.parse(stdout) as LmsModel[];
    } catch {
      return [];
    }
  }

  /** List models via API (lightweight, requires server running) */
  async listModelsApi(): Promise<Array<{ id: string; object: string; owned_by: string }>> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const data = await res.json() as { data: Array<{ id: string; object: string; owned_by: string }> };
      return data.data || [];
    } catch {
      return [];
    }
  }

  /** List currently loaded models in memory */
  async listLoaded(): Promise<LmsLoadedModel[]> {
    try {
      const { stdout } = await execFileAsync(this.lmsBin, ['ps', '--json'], { timeout: 5000 });
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // -- Model Loading ------------------------------------------------

  async loadModel(modelKey: string): Promise<boolean> {
    try {
      await execFileAsync(this.lmsBin, ['load', modelKey], { timeout: 120000 });
      return true;
    } catch {
      return false;
    }
  }

  async unloadModel(modelKey: string): Promise<boolean> {
    try {
      await execFileAsync(this.lmsBin, ['unload', modelKey], { timeout: 30000 });
      return true;
    } catch {
      return false;
    }
  }

  // -- Generation ---------------------------------------------------

  /** Chat completion (OpenAI-compatible) */
  async chat(
    model: string,
    messages: LmsChatMessage[],
    options?: { temperature?: number; max_tokens?: number; stream?: boolean }
  ): Promise<LmsChatResponse> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.max_tokens ?? 2048,
        stream: false,
      }),
    });

    if (!res.ok) throw new Error(`LM Studio chat error: ${res.status} ${res.statusText}`);
    return await res.json() as LmsChatResponse;
  }

  /** Streaming chat — yields tokens via callback */
  async chatStream(
    model: string,
    messages: LmsChatMessage[],
    onToken: (token: string) => void,
    options?: { temperature?: number; max_tokens?: number }
  ): Promise<LmsChatResponse> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.max_tokens ?? 2048,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) throw new Error(`LM Studio stream error: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let usage: LmsChatResponse['usage'] | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const chunk = JSON.parse(line.slice(6));
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            onToken(delta);
          }
          if (chunk.usage) usage = chunk.usage;
        } catch { /* skip */ }
      }
    }

    return {
      id: `lms-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
      usage,
    };
  }

  /** Text completion (non-chat) */
  async generate(
    model: string,
    prompt: string,
    options?: { temperature?: number; max_tokens?: number }
  ): Promise<LmsGenerateResponse> {
    const res = await fetch(`${this.baseUrl}/v1/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.max_tokens ?? 2048,
        stream: false,
      }),
    });

    if (!res.ok) throw new Error(`LM Studio generate error: ${res.status} ${res.statusText}`);
    return await res.json() as LmsGenerateResponse;
  }

  /** Embeddings */
  async embed(model: string, input: string | string[]): Promise<{ embeddings: number[][] }> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
    });

    if (!res.ok) throw new Error(`LM Studio embed error: ${res.status}`);
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return { embeddings: data.data.map((d) => d.embedding) };
  }

  // -- Model Download -----------------------------------------------

  async downloadModel(
    modelKey: string,
    onProgress?: (line: string) => void
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const child = execFile(this.lmsBin, ['get', modelKey], { timeout: 600000 }, (err) => {
        resolve(!err);
      });
      if (onProgress && child.stdout) {
        child.stdout.on('data', (data: Buffer) => onProgress(data.toString().trim()));
      }
      if (onProgress && child.stderr) {
        child.stderr.on('data', (data: Buffer) => onProgress(data.toString().trim()));
      }
    });
  }

  // -- Utilities ----------------------------------------------------

  getBaseUrl(): string {
    return this.baseUrl;
  }
}

export const lmstudio = new LmStudioClient();
