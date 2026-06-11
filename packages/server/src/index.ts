/**
 * Inference Forge — Server Entry Point
 */

import 'dotenv/config';
import express from 'express';
import cors, { type CorsOptions } from 'cors';
import { createServer } from 'http';
import { router } from './api/routes.js';
import { setupWebSocket } from './ws/handler.js';
import { monitor } from './services/monitor.js';
import { hardware } from './services/hardware.js';
import { alerts } from './services/alerts.js';
import { pressure } from './services/pressure.js';
import { database } from './services/database.js';
import { benchmark } from './services/benchmark.js';
import { benchmarkState } from './services/benchmark-state.js';
import { modelRegistry } from './services/model-registry.js';
import { APP_VERSION } from './config/version.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '127.0.0.1';
const app = express();

const LOCALHOST_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin || LOCALHOST_ORIGINS.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS origin not allowed: ${origin}`));
  },
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api', router);

// Create HTTP server (shared with WebSocket)
const server = createServer(app);
setupWebSocket(server);

// Start services
monitor.start();
hardware.start();
pressure.start();
modelRegistry.start();

// Wire alerts into monitor cycle
monitor.subscribe((metrics) => {
  const hwSnapshot = hardware.getLastSnapshot();
  const vramUsedPercent = hwSnapshot && hwSnapshot.totalGpuVramMb > 0
    ? (hwSnapshot.totalGpuVramUsedMb / hwSnapshot.totalGpuVramMb) * 100
    : undefined;

  alerts.evaluate({
    vramUsedPercent,
    runningModelNames: metrics.models.running.map((m) => m.name),
    ollamaOnline: metrics.ollamaOnline,
    gpuTemperatures: hwSnapshot?.gpus.map((g) => g.temperatureCelsius).filter((t): t is number => t !== null),
  });
});

// Persist hardware snapshots every ~2 minutes (60 polls at 2s)
let hwPollCount = 0;
hardware.subscribe((snapshot) => {
  hwPollCount++;
  if (hwPollCount % 60 === 0) {
    database.saveHardwareSnapshot(snapshot);
  }
});

// Persist alerts
alerts.subscribe((alert) => {
  database.saveAlert(alert);
});

// Persist benchmark results (via progress subscription to detect completion)
benchmark.subscribeProgress((message, progress) => {
  if (progress >= 1) {
    const result = benchmarkState.getBenchmarkResult();
    if (result) database.saveBenchmarkRun(result);
  }
});

server.listen(PORT, HOST, () => {
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn(`[Security] Inference Forge is bound to ${HOST}. This local-first server has no authentication; expose only on trusted networks.`);
  }
  console.log(`
  +---------------------------------------+
  |      Inference Forge v${APP_VERSION}           |
  |  http://${HOST}:${PORT}               |
  |  WebSocket: ws://${HOST}:${PORT}/ws    |
  +---------------------------------------+
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  monitor.stop();
  hardware.stop();
  modelRegistry.stop();
  database.close();
  server.close();
  process.exit(0);
});
