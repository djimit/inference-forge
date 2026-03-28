/**
 * Ollama Forge — Server Entry Point
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { router } from './api/routes.js';
import { setupWebSocket } from './ws/handler.js';
import { monitor } from './services/monitor.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// API routes
app.use('/api', router);

// Create HTTP server (shared with WebSocket)
const server = createServer(app);
setupWebSocket(server);

// Start monitoring
monitor.start();

server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║        Ollama Forge Server            ║
  ║  http://localhost:${PORT}               ║
  ║  WebSocket: ws://localhost:${PORT}/ws    ║
  ╚═══════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  monitor.stop();
  server.close();
  process.exit(0);
});
