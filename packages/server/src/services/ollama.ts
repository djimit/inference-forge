/**
 * Ollama API Client
 * Typed client for all Ollama REST API endpoints used by Forge.
 */

// -- Model Architecture Info ----------------------------------------

export interface ModelArchInfo {
  architecture: string;
  blockCount: number;
  embeddingLength: number;
  headCount: number;
  headCountKv: number;
  feedForwardLength: number;
  contextLength: number;
  vocabSize: number;
  quantizationVersion?: number;
}

/**
 * Parse model architecture info from the model_info record returned by /api/show.
 * Keys are architecture-prefixed (e.g. "llama.block_count", "phi3.embedding_length").
 */
export function parseModelArch(modelInfo: ModelInfo): ModelArchInfo | null {
  const info = modelInfo.model_info;
  if (!info || typeof info !== 'object') return null;

  // Detect architecture prefix from "general.architecture" or by scanning keys
  let arch = info['general.architecture'] as string | undefined;
  if (!arch) {
    const archKey = Object.keys(info).find((k) => k.endsWith('.block_count'));
    if (archKey) arch = archKey.split('.')[0];
  }
  if (!arch) return null;

  const get = (suffix: string): number =>
    (typeof info[`${arch}.${suffix}`] === 'number'
      ? info[`${arch}.${suffix}`]
      : typeof info[`general.${suffix}`] === 'number'
      ? info[`general.${suffix}`]
      : 0) as number;

  const blockCount = get('block_count');
  if (!blockCount) return null;

  return {
    architecture: arch,
    blockCount,
    embeddingLength: get('embedding_length'),
    headCount: get('attention.head_count'),
    headCountKv: get('attention.head_count_kv'),
    feedForwardLength: get('feed_forward_length'),
    contextLength: get('context_length') || (info['general.context_length'] as number) || 0,
    vocabSize: (info['general.vocab_size'] as number) || 0,
    quantizationVersion: (info['general.quantization_version'] as number) || undefined,
  };
}

// -- Types ----------------------------------------------------------

export interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
}

export interface RunningModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
  expires_at: string;
  size_vram: number;
}

export interface ModelInfo {
  modelfile: string;
  parameters: string;
  template: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
  model_info: Record<string, unknown>;
}

export interface GenerateRequest {
  model: string;
  prompt: string;
  stream?: boolean;
  options?: Record<string, unknown>;
}

export interface GenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

// -- Client ---------------------------------------------------------

export class OllamaClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    let url = baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434';
    // Ensure protocol prefix — OLLAMA_HOST is often set without http://
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`;
    }
    // Normalize 0.0.0.0 to localhost for fetch compatibility
    url = url.replace('://0.0.0.0:', '://localhost:');
    this.baseUrl = url;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.status} ${res.statusText} — ${path}`);
    }
    return res.json() as Promise<T>;
  }

  /** List all downloaded models */
  async listModels(): Promise<OllamaModel[]> {
    const data = await this.fetch<{ models: OllamaModel[] }>('/api/tags');
    return data.models || [];
  }

  /** List currently running models with VRAM usage */
  async listRunning(): Promise<RunningModel[]> {
    const data = await this.fetch<{ models: RunningModel[] }>('/api/ps');
    return data.models || [];
  }

  /** Get detailed model info */
  async showModel(name: string): Promise<ModelInfo> {
    return this.fetch<ModelInfo>('/api/show', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  /** Run a generation (non-streaming) for benchmarking */
  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    return this.fetch<GenerateResponse>('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ ...request, stream: false }),
    });
  }

  /** Create a model from a Modelfile */
  async createModel(name: string, modelfile: string): Promise<void> {
    await this.fetch<unknown>('/api/create', {
      method: 'POST',
      body: JSON.stringify({ name, modelfile, stream: false }),
    });
  }

  /** Delete a model */
  async deleteModel(name: string): Promise<void> {
    const url = `${this.baseUrl}/api/delete`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.status} ${res.statusText} — /api/delete`);
    }
  }

  /**
   * Pull a model with streaming progress.
   * Yields progress events: { status, digest?, total?, completed? }
   */
  async pullModel(
    name: string,
    onProgress: (event: { status: string; digest?: string; total?: number; completed?: number }) => void
  ): Promise<void> {
    const url = `${this.baseUrl}/api/pull`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Pull failed: ${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
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
          const event = JSON.parse(line);
          onProgress(event);
        } catch { /* skip */ }
      }
    }
  }

  /** Check if Ollama is reachable */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Get the base URL */
  getBaseUrl(): string {
    return this.baseUrl;
  }
}

export const ollama = new OllamaClient();
