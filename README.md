# Inference Forge

All-in-one desktop management suite for local LLM inference — real-time monitoring, KV cache benchmarking, and smart Modelfile generation. Currently supports [Ollama](https://ollama.com) as the inference backend.

![Inference Forge Dashboard](docs/screenshots/dashboard-preview.png)
<!-- TODO: Replace with actual screenshot after first launch -->

> **Architectural remediation program in progress.** See [`openspec/changes/README.md`](openspec/changes/README.md) for four sequenced change proposals (backend abstraction, perplexity rigor, auth layer, Modelfile Studio gate) that must land before v0.4/v0.5 roadmap items proceed. The roadmap entries below are annotated with their blocking dependencies.

## Features

- **Real-time Dashboard** — VRAM usage, model status, KV cache pressure, time-series metrics via WebSocket
- **KV Cache Benchmarker** — Automated testing across f16/q8_0/q4_0 configurations with standardized prompts
- **Smart Modelfile Generator** — Hardware-aware parameter optimization with use-case templates (chat, coding, analysis, creative, agent)

## Quick Start

```bash
# Prerequisites: Node.js >= 18, Ollama running on localhost:11434

# Install dependencies
npm install

# Start development (backend + frontend)
npm run dev

# Verify backend health
curl http://127.0.0.1:3001/api/health

# Open http://localhost:3000
```

## Architecture

Monorepo with two packages:

| Package | Description | Port |
|---------|-------------|------|
| `@inference-forge/server` | Express + WebSocket backend | 3001 |
| `@inference-forge/dashboard` | React + Vite frontend | 3000 |

## KV Cache Optimization

Ollama supports KV cache quantization via environment variable:

**Linux / macOS:**

```bash
export OLLAMA_KV_CACHE_TYPE=q8_0    # Half memory, minimal quality loss
export OLLAMA_FLASH_ATTENTION=1      # Required for KV quantization
ollama serve
```

**Windows (PowerShell):**

```powershell
$env:OLLAMA_KV_CACHE_TYPE = "q8_0"
$env:OLLAMA_FLASH_ATTENTION = "1"
ollama serve
```

| Type | Memory vs f16 | Quality Impact |
|------|---------------|----------------|
| f16  | 1x (default)  | None           |
| q8_0 | ~0.5x         | Very small     |
| q4_0 | ~0.25x        | Small-medium   |

## Tech Stack

TypeScript, Node.js, Express, WebSocket, React 18, Vite, TailwindCSS, Recharts

## Roadmap

### v0.2 — Enhanced Monitoring
- GPU hardware detection (NVIDIA via `nvidia-smi`, AMD via `rocm-smi`)
- Per-model token throughput tracking over time
- Alert thresholds for VRAM pressure and model eviction

### v0.3 — Advanced Benchmarking
- Perplexity via log-likelihood comparison across KV cache types  
  > **Note (proposal 02):** the current `POST /api/perplexity/*` returns a *latency-derived* number, not true perplexity. It is being replaced by a real WikiText-2 NLL measurement; see `openspec/changes/02-perplexity-benchmark-rigor/`. Treat current perplexity output as non-authoritative.
- Custom prompt sets and configurable run parameters
- Export benchmark reports to PDF and JSON
- Side-by-side model comparison charts

### v0.4 — Modelfile Studio — ⛔ Blocked on #01, #02, #03
> **Gate (proposal 04):** implementation SHALL NOT proceed until proposals 01 (backend abstraction), 02 (benchmark rigor), and 03 (auth layer) are merged. Modelfile Studio is a write-capable, Ollama-specific feature; building it before the foundation lands means re-designing it once a second backend is added and shipping an unauthenticated config-tampering surface. Already-scaffolded routes (`/modelfile/generate`, `/modelfile/generate-auto`, `/templates/:id/create`) are write-capable and MUST NOT be exposed beyond loopback until proposal 03 lands.
- Visual Modelfile editor with live preview
- Import/export Modelfile library
- Community template gallery
- One-click model creation via API

### v0.5 — Multi-Agent Support — ⛔ Blocked on #01, #02, #03
> **Gate (proposal 04):** already partially scaffolded (`services/orchestrator.ts`, `/agents`, `/sessions`, `/workflows` routes). No further scope until proposals 01–03 are merged. Orchestrating multiple models across multiple backends without a stable backend contract multiplies an already-straining foundation's surface.
- Concurrent model orchestration dashboard
- Agent workflow builder with model routing
- Session and conversation memory management
- Resource allocation across running agents

### Future
- Advanced KV cache compression techniques (e.g. PolarQuant-style quantization) when available in llama.cpp
- Electron desktop app packaging
- Remote instance management — requires the auth layer from proposal 03; a non-loopback deployment without auth is an unaddressed security gap, not a roadmap feature
- Plugin system for custom metrics and tools
- Additional inference backend support (vLLM, llama.cpp server) — enabled by the port/adapter seam from proposal 01; a real second/third adapter is a follow-up change once the seam lands

## Contributing

Contributions are welcome! Here's how to get started.

### Development Setup

```bash
git clone https://github.com/DjimIT/inference-forge.git
cd inference-forge
npm install
npm run dev
```

The backend binds to `127.0.0.1:3001` by default and the dashboard runs on `http://localhost:3000` with hot reload enabled for both. Set `HOST` explicitly only on trusted networks; the local-first server does not provide authentication yet and restricts browser CORS to localhost origins.

Use `npm run typecheck` to run TypeScript checks for both workspaces without emitting build artifacts.

### Project Structure

```
inference-forge/
├── packages/server/       # Express + WebSocket backend
│   └── src/
│       ├── api/           # REST API routes
│       ├── services/      # Ollama client, monitor, benchmark, modelfile
│       └── ws/            # WebSocket handlers
├── packages/dashboard/    # React + Vite frontend
│   └── src/
│       ├── components/    # UI components
│       └── hooks/         # WebSocket and API hooks
└── docs/                  # Documentation and screenshots
```

### Guidelines

- **TypeScript** — all code must be fully typed, no `any` in production code
- **Branching** — create feature branches from `main` (e.g. `feature/gpu-detection`)
- **Commits** — use conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`)
- **Pull requests** — include a description of what changed and why, plus testing steps
- **Tests** — add tests for new services and API routes (test framework TBD in v0.2)

### Reporting Issues

Open an issue on GitHub with:
1. Your OS and Node.js version
2. Ollama version and running models
3. Steps to reproduce the problem
4. Expected vs actual behavior

## License

MIT — DjimIT B.V.
