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

server.listen(PORT, () => {
  console.log(`
  +---------------------------------------+
  |      Inference Forge v0.5.0           |
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
  server.close();
  process.exit(0);
});
