import { useState, useEffect, useCallback, useRef } from 'react';

interface Model {
  name: string;
  size: number;
  details: {
    parameter_size: string;
    quantization_level: string;
    family: string;
  };
}

interface RunningModel extends Model {
  size_vram: number;
  expires_at: string;
}

interface SystemMetrics {
  timestamp: number;
  models: {
    available: Model[];
    running: RunningModel[];
  };
  vram: {
    totalUsed: number;
    totalAvailable: number;
    perModel: Array<{
      name: string;
      sizeVram: number;
      sizeTotal: number;
      parameterSize: string;
      quantization: string;
    }>;
  };
  kvCache: {
    estimatedPerModel: Array<{
      name: string;
      estimatedKvBytes: number;
      kvCacheType: string;
      numCtx: number;
    }>;
  };
  ollamaOnline: boolean;
}

interface GpuInfo {
  index: number;
  name: string;
  vendor: string;
  vramTotalMb: number;
  vramUsedMb: number;
  vramFreeMb: number;
  utilizationPercent: number;
  temperatureCelsius: number | null;
  powerDrawWatts: number | null;
  driverVersion: string;
}

interface HardwareSnapshot {
  system: { platform: string; cpuModel: string; cpuCores: number; ramTotalMb: number; ramFreeMb: number; ramUsedMb: number };
  gpus: GpuInfo[];
  totalGpuVramMb: number;
  totalGpuVramUsedMb: number;
}

interface AlertData {
  id: string;
  timestamp: number;
  severity: 'info' | 'warning' | 'critical';
  category: string;
  title: string;
  message: string;
  acknowledged: boolean;
}

interface ThroughputData {
  models: Record<string, {
    model: string;
    samples: Array<{ timestamp: number; tokensPerSecond: number }>;
    avgTokensPerSecond: number;
    peakTokensPerSecond: number;
    totalRequests: number;
  }>;
  globalAvgTps: number;
}

interface PressureData {
  pressureLevel: string;
  vramUsedMb: number;
  vramTotalMb: number;
  loadedModels?: Array<{ name: string; vramUsageMb: number }>;
  advice: string;
  concurrentModelLimit: number;
}

interface WSMessage {
  type: string;
  data: unknown;
}

export interface BenchmarkProgress {
  message: string;
  progress: number;
}

export function useWebSocket(url: string) {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [hardwareData, setHardwareData] = useState<HardwareSnapshot | null>(null);
  const [alertsData, setAlertsData] = useState<AlertData[]>([]);
  const [throughputData, setThroughputData] = useState<ThroughputData | null>(null);
  const [pressureData, setPressureData] = useState<PressureData | null>(null);
  const [benchmarkProgress, setBenchmarkProgress] = useState<BenchmarkProgress | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

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
            setMetrics(msg.data as SystemMetrics);
            break;
          case 'hardware':
            setHardwareData(msg.data as HardwareSnapshot);
            break;
          case 'alert':
            setAlertsData((prev) => [msg.data as AlertData, ...prev].slice(0, 50));
            break;
          case 'alerts':
            setAlertsData(Array.isArray(msg.data) ? msg.data as AlertData[] : []);
            break;
          case 'throughput':
            setThroughputData(msg.data as ThroughputData);
            break;
          case 'pressure':
            setPressureData(msg.data as PressureData);
            break;
          case 'benchmark-progress':
            setBenchmarkProgress(msg.data as BenchmarkProgress);
            if ((msg.data as BenchmarkProgress).progress >= 1) {
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
