/**
 * Ollama API Client
 * Typed client for all Ollama REST API endpoints used by Forge.
 */

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
