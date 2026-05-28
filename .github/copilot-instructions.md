# Copilot Instructions — inference-forge

> See root `.github/copilot-instructions.md` for global conventions.

Local LLM inference management suite: real-time monitoring, KV cache benchmarking, and Modelfile generation. Supports Ollama as the inference backend.

## Commands

```bash
# Install all workspace dependencies
npm install

# Development (backend port 3001 + frontend port 3000, hot reload)
npm run dev
npm run dev:server     # backend only (tsx watch)
npm run dev:dashboard  # frontend only (vite)

# Production build
npm run build          # compiles server (tsc) + dashboard (tsc + vite)
npm start              # runs compiled server only

# Type checking (no linter or test framework yet — planned for v0.2)
cd packages/server && npx tsc --noEmit
cd packages/dashboard && npx tsc --noEmit
```

Requires Ollama running on `localhost:11434` (or `OLLAMA_HOST` env var).

## Architecture

Monorepo (`npm workspaces`). The backend (`packages/server`) is the single source of truth — it polls Ollama every 1s and fans metrics out over WebSocket at `/ws`. The React dashboard (`packages/dashboard`) never calls Ollama directly; it only consumes the WebSocket stream.

```
packages/server/src/
├── index.ts              # Express + HTTP server entry, starts all services
├── api/routes.ts         # 60+ REST endpoints (health, models, metrics, benchmark, modelfile, agents)
├── services/
│   ├── ollama.ts         # Typed Ollama API client
│   ├── monitor.ts        # 1s polling loop, emits SystemMetrics
│   ├── hardware.ts       # GPU detection (nvidia-smi / rocm-smi)
│   ├── benchmark.ts      # KV cache benchmarking (f16/q8_0/q4_0)
│   ├── modelfile.ts      # Hardware-aware Modelfile generator
│   ├── perplexity.ts     # Log-likelihood KV cache comparison
│   ├── alerts.ts         # Threshold-based alerting (VRAM, temps, offline)
│   ├── throughput.ts     # Per-model token/s tracking over time
│   ├── prompt-library.ts # Persistent prompt set management
│   ├── modelfile-library.ts
│   └── orchestrator.ts   # Multi-agent sessions (v0.5, scaffolded)
└── ws/handler.ts         # WebSocket on /ws — broadcasts metrics, alerts, throughput

packages/dashboard/src/
├── App.tsx               # Renders Dashboard only
├── components/Dashboard.tsx  # Three tabs (Monitor / Benchmark / Modelfile), WebSocket connect
├── components/           # VramGauge, ModelList, KvCachePanel, MetricsChart, BenchmarkRunner, etc.
└── hooks/
    ├── useWebSocket.ts   # WebSocket management, 3s auto-reconnect
    └── useOllama.ts      # REST API wrapper for benchmarks and modelfile generation
```

## Key Details

- **TypeScript strict mode throughout** — no `any` in production code.
- **Benchmark results stored in `globalThis`** in `api/routes.ts` — lost on server restart, intentional.
- **KV cache estimates are calculated, not measured** — `monitor.ts` computes them from model architecture.
- **Agent/Session/Workflow endpoints are scaffolded** (v0.5 roadmap) but not fully wired to UI.
- **Vite dev server proxies `/api/*` and `/ws/*` to port 3001** — frontend dev server must be started alongside backend.
- **Server uses ESM** (`"type": "module"`) — import paths need `.js` extensions in compiled output.
- **No auth** — all endpoints are open; designed for localhost use only.

## Environment

Copy `.env.example` to `.env` in `packages/server/`:
- `PORT` — default `3001`
- `OLLAMA_HOST` — default `http://localhost:11434`

KV cache quantization is configured on the Ollama side, not here:
```bash
export OLLAMA_KV_CACHE_TYPE=q8_0
export OLLAMA_FLASH_ATTENTION=1
ollama serve
```
