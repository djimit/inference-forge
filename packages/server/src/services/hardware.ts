/**
 * Hardware Detection Service
 * Detects GPU (NVIDIA via nvidia-smi, AMD via rocm-smi) and system specs.
 * Cross-platform: Windows, Linux, macOS.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { cpus, totalmem, freemem, platform } from 'os';

const execAsync = promisify(exec);

// -- Types ----------------------------------------------------------

export interface GpuInfo {
  index: number;
  name: string;
  vendor: 'nvidia' | 'amd' | 'apple' | 'unknown';
  vramTotalMb: number;
  vramUsedMb: number;
  vramFreeMb: number;
  utilizationPercent: number;
  temperatureCelsius: number | null;
  powerDrawWatts: number | null;
  driverVersion: string;
}

export interface SystemInfo {
  platform: string;
  cpuModel: string;
  cpuCores: number;
  ramTotalMb: number;
  ramFreeMb: number;
  ramUsedMb: number;
}

export interface HardwareSnapshot {
  timestamp: number;
  system: SystemInfo;
  gpus: GpuInfo[];
  totalGpuVramMb: number;
  totalGpuVramUsedMb: number;
}

// -- NVIDIA Detection -----------------------------------------------

async function detectNvidia(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw,driver_version --format=csv,noheader,nounits',
      { timeout: 5000 }
    );

    return stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const [index, name, memTotal, memUsed, memFree, util, temp, power, driver] =
          line.split(',').map((s) => s.trim());

        return {
          index: parseInt(index, 10),
          name: name || 'Unknown NVIDIA GPU',
          vendor: 'nvidia' as const,
          vramTotalMb: parseFloat(memTotal) || 0,
          vramUsedMb: parseFloat(memUsed) || 0,
          vramFreeMb: parseFloat(memFree) || 0,
          utilizationPercent: parseFloat(util) || 0,
          temperatureCelsius: temp ? parseFloat(temp) : null,
          powerDrawWatts: power ? parseFloat(power) : null,
          driverVersion: driver || 'unknown',
        };
      });
  } catch {
    return [];
  }
}

// -- AMD Detection --------------------------------------------------

async function detectAmd(): Promise<GpuInfo[]> {
  try {
    // Try rocm-smi first (Linux)
    const { stdout } = await execAsync(
      'rocm-smi --showmeminfo vram --showtemp --showuse --showid --csv',
      { timeout: 5000 }
    );

    const lines = stdout.trim().split('\n');
    if (lines.length < 2) return [];

    const gpus: GpuInfo[] = [];
    // Parse CSV output — format varies by rocm-smi version
    for (let i = 1; i < lines.length; i++) {
      const fields = lines[i].split(',').map((s) => s.trim());
      gpus.push({
        index: i - 1,
        name: `AMD GPU ${i - 1}`,
        vendor: 'amd',
        vramTotalMb: parseFloat(fields[1]) / (1024 * 1024) || 0,
        vramUsedMb: parseFloat(fields[2]) / (1024 * 1024) || 0,
        vramFreeMb: 0, // calculated below
        utilizationPercent: parseFloat(fields[3]) || 0,
        temperatureCelsius: parseFloat(fields[4]) || null,
        powerDrawWatts: null,
        driverVersion: 'rocm',
      });
    }

    // Calculate free VRAM
    for (const gpu of gpus) {
      gpu.vramFreeMb = gpu.vramTotalMb - gpu.vramUsedMb;
    }

    return gpus;
  } catch {
    // Try alternative AMD detection on Windows
    try {
      const { stdout } = await execAsync(
        'wmic path win32_VideoController get Name,AdapterRAM /format:csv',
        { timeout: 5000 }
      );
      const lines = stdout.trim().split('\n').filter((l) => l.includes('AMD') || l.includes('Radeon'));
      return lines.map((line, idx) => {
        const fields = line.split(',');
        const ram = parseInt(fields[fields.length - 1], 10) || 0;
        return {
          index: idx,
          name: fields[fields.length - 2] || 'AMD GPU',
          vendor: 'amd' as const,
          vramTotalMb: ram / (1024 * 1024),
          vramUsedMb: 0,
          vramFreeMb: ram / (1024 * 1024),
          utilizationPercent: 0,
          temperatureCelsius: null,
          powerDrawWatts: null,
          driverVersion: 'unknown',
        };
      });
    } catch {
      return [];
    }
  }
}

// -- Apple Silicon Detection ----------------------------------------

async function detectAppleSilicon(): Promise<GpuInfo[]> {
  if (platform() !== 'darwin') return [];

  try {
    // Check if running on Apple Silicon
    const { stdout: archOut } = await execAsync('uname -m', { timeout: 3000 });
    if (!archOut.trim().includes('arm64')) return [];

    // Get chip info via system_profiler
    const { stdout } = await execAsync(
      'system_profiler SPDisplaysDataType -json',
      { timeout: 10000 }
    );

    const data = JSON.parse(stdout);
    const displays = data?.SPDisplaysDataType || [];

    return displays.map((display: any, idx: number) => {
      const chipName = display.sppci_model || 'Apple Silicon GPU';
      // Apple Silicon uses unified memory — get total system RAM as shared GPU memory
      const totalRamMb = totalmem() / (1024 * 1024);
      // Heuristic: Apple allocates ~75% of unified memory to GPU when needed
      const gpuAllocMb = Math.round(totalRamMb * 0.75);

      return {
        index: idx,
        name: chipName,
        vendor: 'apple' as const,
        vramTotalMb: gpuAllocMb,
        vramUsedMb: 0, // Unified memory — hard to measure GPU-specific usage
        vramFreeMb: gpuAllocMb,
        utilizationPercent: 0,
        temperatureCelsius: null,
        powerDrawWatts: null,
        driverVersion: 'metal',
      };
    });
  } catch {
    return [];
  }
}

// -- System Info ----------------------------------------------------

function getSystemInfo(): SystemInfo {
  const cpuInfo = cpus();
  const totalMb = Math.round(totalmem() / (1024 * 1024));
  const freeMb = Math.round(freemem() / (1024 * 1024));

  return {
    platform: platform(),
    cpuModel: cpuInfo[0]?.model || 'Unknown CPU',
    cpuCores: cpuInfo.length,
    ramTotalMb: totalMb,
    ramFreeMb: freeMb,
    ramUsedMb: totalMb - freeMb,
  };
}

// -- Main Detection -------------------------------------------------

export class HardwareService {
  private lastSnapshot: HardwareSnapshot | null = null;
  private pollIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private listeners: Set<(snapshot: HardwareSnapshot) => void> = new Set();

  constructor(pollIntervalMs = 2000) {
    this.pollIntervalMs = pollIntervalMs;
  }

  async detect(): Promise<HardwareSnapshot> {
    const system = getSystemInfo();

    // Detect GPUs in parallel
    const [nvidia, amd, apple] = await Promise.all([
      detectNvidia(),
      detectAmd(),
      detectAppleSilicon(),
    ]);

    const gpus = [...nvidia, ...amd, ...apple];

    const snapshot: HardwareSnapshot = {
      timestamp: Date.now(),
      system,
      gpus,
      totalGpuVramMb: gpus.reduce((sum, g) => sum + g.vramTotalMb, 0),
      totalGpuVramUsedMb: gpus.reduce((sum, g) => sum + g.vramUsedMb, 0),
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  subscribe(callback: (snapshot: HardwareSnapshot) => void): () => void {
    this.listeners.add(callback);
    if (this.lastSnapshot) callback(this.lastSnapshot);
    return () => this.listeners.delete(callback);
  }

  start(): void {
    if (this.intervalId) return;
    this.poll();
    this.intervalId = setInterval(() => this.poll(), this.pollIntervalMs);
    console.log(`[Hardware] Polling every ${this.pollIntervalMs}ms`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getLastSnapshot(): HardwareSnapshot | null {
    return this.lastSnapshot;
  }

  private async poll(): Promise<void> {
    try {
      const snapshot = await this.detect();
      for (const cb of this.listeners) {
        try { cb(snapshot); } catch {}
      }
    } catch (err) {
      console.error('[Hardware] Poll error:', err);
    }
  }
}

export const hardware = new HardwareService();
