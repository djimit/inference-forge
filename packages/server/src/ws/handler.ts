/**
 * WebSocket Handler
 * Streams real-time metrics to connected dashboard clients.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { monitor, type SystemMetrics } from '../services/monitor.js';

export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    console.log('[WS] Client connected');

    // Subscribe this client to monitor updates
    const unsubscribe = monitor.subscribe((metrics: SystemMetrics) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'metrics', data: metrics }));
      }
    });

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      unsubscribe();
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err);
      unsubscribe();
    });

    // Send initial state
    const lastMetrics = monitor.getLastMetrics();
    if (lastMetrics) {
      ws.send(JSON.stringify({ type: 'metrics', data: lastMetrics }));
    }
  });

  console.log('[WS] WebSocket server ready on /ws');
  return wss;
}
