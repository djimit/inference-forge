# Ollama Forge

All-in-one desktop management suite for [Ollama](https://ollama.com) — real-time monitoring, KV cache benchmarking, and smart Modelfile generation.

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

# Open http://localhost:3000
```

## Architecture

Monorepo with two packages:

| Package | Description | Port |
|---------|-------------|------|
| `@ollama-forge/server` | Express + WebSocket backend | 3001 |
| `@ollama-forge/dashboard` | React + Vite frontend | 3000 |

## KV Cache Optimization

Ollama supports KV cache quantization via environment variable:

```bash
# Set before starting Ollama
export OLLAMA_KV_CACHE_TYPE=q8_0    # Half memory, minimal quality loss
export OLLAMA_FLASH_ATTENTION=1      # Required for KV quantization
ollama serve
```

| Type | Memory vs f16 | Quality Impact |
|------|---------------|----------------|
| f16  | 1x (default)  | None           |
| q8_0 | ~0.5x         | Very small     |
| q4_0 | ~0.25x        | Small-medium   |

## Tech Stack

TypeScript, Node.js, Express, WebSocket, React 18, Vite, TailwindCSS, Recharts

## License

MIT — DjimIT B.V.
