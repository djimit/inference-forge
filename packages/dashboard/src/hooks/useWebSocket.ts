import { useState, useEffect, useCallback, useRef } from 'react';

interface WSMessage {
  type: string;
  data: any;
}

export interface BenchmarkProgress {
  message: string;
  progress: number;
}

export function useWebSocket(url: string) {
  const [metrics, setMetrics] = useState<any>(null);
  const [hardwareData, setHardwareData] = useState<any>(null);
  const [alertsData, setAlertsData] = useState<any[]>([]);
  const [throughputData, setThroughputData] = useState<any>(null);
  const [pressureData, setPressureData] = useState<any>(null);
  const [benchmarkProgress, setBenchmarkProgress] = useState<BenchmarkProgress | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        switch (msg.type) {
          case 'metrics':
            setMetrics(msg.data);
            break;
          case 'hardware':
            setHardwareData(msg.data);
            break;
          case 'alert':
            setAlertsData((prev) => [msg.data, ...prev].slice(0, 50));
            break;
          case 'alerts':
            setAlertsData(Array.isArray(msg.data) ? msg.data : []);
            break;
          case 'throughput':
            setThroughputData(msg.data);
            break;
          case 'pressure':
            setPressureData(msg.data);
            break;
          case 'benchmark-progress':
            setBenchmarkProgress(msg.data);
            // Clear progress after completion
            if (msg.data.progress >= 1) {
              setTimeout(() => setBenchmarkProgress(null), 3000);
            }
            break;
        }
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return {
    metrics, connected,
    hardwareData, alertsData, throughputData,
    pressureData, benchmarkProgress,
  };
}
