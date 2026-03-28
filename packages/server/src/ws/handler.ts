/**
 * WebSocket Handler
 * Streams real-time metrics, hardware data, alerts, and throughput to dashboard clients.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { monitor, type SystemMetrics } from '../services/monitor.js';
import { hardware, type HardwareSnapshot } from '../services/hardware.js';
import { alerts, type Alert } from '../services/alerts.js';
import { throughput, type ThroughputSnapshot } from '../services/throughput.js';

export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    console.log('[WS] Client connected');

    const unsubscribers: Array<() => void> = [];

    // Subscribe to monitor metrics
    unsubscribers.push(
      monitor.subscribe((metrics: SystemMetrics) => {
        send(ws, 'metrics', metrics);
      })
    );

    // Subscribe to hardware snapshots
    unsubscribers.push(
      hardware.subscribe((snapshot: HardwareSnapshot) => {
        send(ws, 'hardware', snapshot);
      })
    );

    // Subscribe to alerts
    unsubscribers.push(
      alerts.subscribe((alert: Alert) => {
        send(ws, 'alert', alert);
      })
    );

    // Subscribe to throughput updates
    unsubscribers.push(
      throughput.subscribe((snapshot: ThroughputSnapshot) => {
        send(ws, 'throughput', snapshot);
      })
    );

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      unsubscribers.forEach((unsub) => unsub());
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err);
      unsubscribers.forEach((unsub) => unsub());
    });

    // Send initial state
    const lastMetrics = monitor.getLastMetrics();
    if (lastMetrics) send(ws, 'metrics', lastMetrics);

    const lastHw = hardware.getLastSnapshot();
    if (lastHw) send(ws, 'hardware', lastHw);

    send(ws, 'alerts', alerts.getAlerts());
    send(ws, 'throughput', throughput.getSnapshot());
  });

  console.log('[WS] WebSocket server ready on /ws');
  return wss;
}

function send(ws: WebSocket, type: string, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}
