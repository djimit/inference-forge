/**
 * Inference Forge — Server Entry Point
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { router } from './api/routes.js';
import { setupWebSocket } from './ws/handler.js';
import { monitor } from './services/monitor.js';
import { hardware } from './services/hardware.js';
import { alerts } from './services/alerts.js';
import { pressure } from './services/pressure.js';
import { database } from './services/database.js';
import { benchmark } from './services/benchmark.js';
import { modelRegistry } from './services/model-registry.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const app = express();

// Middleware
app.use(cors());
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
    const result = (globalThis as any).__lastBenchmarkResult;
    if (result) database.saveBenchmarkRun(result);
  }
});

server.listen(PORT, () => {
  console.log(`
  +---------------------------------------+
  |      Inference Forge v0.3.0           |
  |  http://localhost:${PORT}               |
  |  WebSocket: ws://localhost:${PORT}/ws    |
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
