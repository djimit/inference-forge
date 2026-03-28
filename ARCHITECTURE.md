# Ollama Forge — Architecture & Build Plan

## Project Overview
**Ollama Forge** is an all-in-one desktop management suite for Ollama, built with Node.js + React. It provides real-time monitoring, KV cache benchmarking, and intelligent Modelfile generation.

## Architecture

```
ollama-forge/
├── packages/
│   ├── server/          # Express + WebSocket backend
│   │   ├── src/
│   │   │   ├── api/           # REST API routes
│   │   │   ├── services/      # Business logic
│   │   │   │   ├── ollama.ts        # Ollama API client
│   │   │   │   ├── monitor.ts       # Real-time metrics polling
│   │   │   │   ├── benchmark.ts     # KV cache benchmarker
│   │   │   │   └── modelfile.ts     # Modelfile generator
│   │   │   ├── ws/            # WebSocket handlers
│   │   │   └── index.ts       # Server entry
│   │   └── package.json
│   └── dashboard/       # React frontend (Vite)
│       ├── src/
│       │   ├── components/
│       │   │   ├── Dashboard.tsx      # Main monitoring view
│       │   │   ├── ModelList.tsx       # Running/available models
│       │   │   ├── VramGauge.tsx       # VRAM usage gauge
│       │   │   ├── KvCachePanel.tsx    # KV cache stats
│       │   │   ├── BenchmarkRunner.tsx # Benchmark UI
│       │   │   ├── ModelfileEditor.tsx # Modelfile generator
│       │   │   └── MetricsChart.tsx    # Time-series charts
│       │   ├── hooks/
│       │   │   ├── useWebSocket.ts    # Real-time data hook
│       │   │   └── useOllama.ts       # API query hooks
│       │   ├── App.tsx
│       │   └── main.tsx
│       └── package.json
├── package.json         # Workspace root
├── tsconfig.json
└── README.md
```

## Tech Stack
| Layer      | Technology                          |
|------------|-------------------------------------|
| Backend    | Node.js, Express, ws (WebSocket)    |
| Frontend   | React 18, Vite, TailwindCSS         |
| Charts     | Recharts                            |
| State      | TanStack Query (server state)       |
| Language   | TypeScript throughout                |

## Ollama API Integration

### Endpoints Used
| Endpoint             | Method | Purpose                              |
|----------------------|--------|--------------------------------------|
| `/api/tags`          | GET    | List all downloaded models           |
| `/api/ps`            | GET    | List running models (VRAM, size)     |
| `/api/show`          | POST   | Model details (params, quant, arch)  |
| `/api/generate`      | POST   | Benchmark inference (streaming)      |
| `/api/chat`          | POST   | Benchmark chat (streaming)           |

### KV Cache Configuration
| Type   | Memory vs f16 | Precision Loss       |
|--------|---------------|----------------------|
| f16    | 1x (default)  | None                 |
| q8_0   | ~0.5x         | Very small           |
| q4_0   | ~0.25x        | Small-medium         |

**Env var:** `OLLAMA_KV_CACHE_TYPE` (requires Flash Attention enabled)

## Build Phases

### Phase 1: Core Backend (ollama client + API server)
- Ollama API client with full TypeScript types
- Express REST API proxying Ollama endpoints with enrichment
- WebSocket server for real-time metric streaming
- Metrics polling service (1s interval for running models)

### Phase 2: Dashboard (real-time monitoring)
- Model list (running + available) with status indicators
- VRAM usage gauges per model and total
- KV cache pressure visualization
- Context window utilization
- Time-series charts (tokens/sec, memory over time)

### Phase 3: KV Cache Benchmarker
- Automated benchmark runner: tests f16, q8_0, q4_0
- Standardized test prompts (short, medium, long context)
- Metrics collected: tokens/sec, VRAM delta, eval time
- Perplexity estimation via log-likelihood comparison
- Results export (JSON + visual report)

### Phase 4: Smart Modelfile Generator
- Hardware detection (GPU VRAM, system RAM)
- Model-aware parameter optimization
- num_ctx auto-sizing based on available memory
- KV cache type recommendation per model
- Modelfile export with inline documentation
- Template library for common use cases

## Key Design Decisions
1. **Monorepo with npm workspaces** — shared types, single install
2. **WebSocket for monitoring** — real-time without polling from frontend
3. **Backend polls Ollama** — single source of truth, reduces Ollama API load
4. **TypeScript throughout** — type safety across client/server boundary
5. **Ollama default port** — connects to localhost:11434, configurable via env
