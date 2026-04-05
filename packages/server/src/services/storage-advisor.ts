/**
 * Storage Advisor Service
 * Monitors disk usage for model directories, detects capacity issues,
 * and recommends optimizations (dedup, tiered storage, pruning).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { platform } from 'os';
import { modelRegistry, type RegistrySnapshot, type Backend } from './model-registry.js';

const execFileAsync = promisify(execFile);

// -- Types ----------------------------------------------------------

export interface DriveCapacity {
  drive: string;
  totalGb: number;
  usedGb: number;
  freeGb: number;
  usedPercent: number;
}

export interface StorageRecommendation {
  severity: 'info' | 'warning' | 'critical';
  category: 'capacity' | 'dedup' | 'placement' | 'pruning';
  message: string;
  savingsMb?: number;
}

export interface StorageReport {
  timestamp: number;
  drives: DriveCapacity[];
  modelDrives: Record<Backend, { drive: string; path: string }>;
  totalModelStorageMb: number;
  storageByBackend: Record<Backend, number>;
  recommendations: StorageRecommendation[];
}

// -- Service --------------------------------------------------------

export class StorageAdvisor {
  async generateReport(): Promise<StorageReport> {
    const [drives, registry] = await Promise.all([
      this.getDriveCapacities(),
      this.getRegistrySnapshot(),
    ]);

    const modelDrives: Record<string, { drive: string; path: string }> = {
      ollama: {
        drive: (process.env.OLLAMA_MODELS || 'C:\\Users').charAt(0).toUpperCase(),
        path: process.env.OLLAMA_MODELS || 'default',
      },
      lmstudio: {
        drive: 'C', // LM Studio typically in user profile
        path: '~/.lmstudio/models',
      },
    };

    // Detect LMS model path from lms ls output
    try {
      const { stdout } = await execFileAsync('lms', ['ls', '--json'], { timeout: 5000 });
      const models = JSON.parse(stdout);
      if (models[0]?.path) {
        // LMS stores in ~/.lmstudio/models/<path>
        const lmsBase = process.env.LMS_MODELS_DIR || `${process.env.USERPROFILE || process.env.HOME}/.lmstudio/models`;
        const drive = lmsBase.charAt(0).toUpperCase();
        modelDrives.lmstudio = { drive, path: lmsBase };
      }
    } catch { /* use default */ }

    const recommendations = this.analyze(drives, registry, modelDrives);

    return {
      timestamp: Date.now(),
      drives,
      modelDrives: modelDrives as Record<Backend, { drive: string; path: string }>,
      totalModelStorageMb: registry?.totalStorageMb || 0,
      storageByBackend: registry?.totalStorageByBackend || { ollama: 0, lmstudio: 0 },
      recommendations,
    };
  }

  private analyze(
    drives: DriveCapacity[],
    registry: RegistrySnapshot | null,
    modelDrives: Record<string, { drive: string; path: string }>
  ): StorageRecommendation[] {
    const recs: StorageRecommendation[] = [];

    // Check drive capacity
    for (const drive of drives) {
      if (drive.freeGb < 20) {
        recs.push({
          severity: 'critical',
          category: 'capacity',
          message: `Drive ${drive.drive}: only ${drive.freeGb.toFixed(1)}GB free. Model downloads may fail.`,
        });
      } else if (drive.freeGb < 50) {
        recs.push({
          severity: 'warning',
          category: 'capacity',
          message: `Drive ${drive.drive}: ${drive.freeGb.toFixed(1)}GB free. Large models (70B+) may not fit.`,
        });
      }
    }

    if (!registry) return recs;

    // Check for duplicates
    for (const dup of registry.duplicates) {
      const m1 = registry.models.find((m) => m.id === dup.model1);
      const m2 = registry.models.find((m) => m.id === dup.model2);
      const savingsMb = Math.min(m1?.sizeMb || 0, m2?.sizeMb || 0);
      recs.push({
        severity: 'warning',
        category: 'dedup',
        message: `${dup.reason}. Removing the smaller copy saves ${(savingsMb / 1024).toFixed(1)}GB.`,
        savingsMb,
      });
    }

    // Check if models are on different drives than optimal
    const ollamaDrive = modelDrives.ollama?.drive;
    const lmsDrive = modelDrives.lmstudio?.drive;
    if (ollamaDrive && lmsDrive && ollamaDrive !== lmsDrive) {
      recs.push({
        severity: 'info',
        category: 'placement',
        message: `Models split across ${ollamaDrive}: (Ollama) and ${lmsDrive}: (LM Studio). Consider consolidating on fastest NVMe for uniform load times.`,
      });
    }

    // Check total storage vs available
    const modelDriveLetters = new Set([ollamaDrive, lmsDrive].filter(Boolean));
    for (const driveLetter of modelDriveLetters) {
      const drive = drives.find((d) => d.drive.startsWith(driveLetter!));
      if (drive && registry.totalStorageMb > 0) {
        const modelPct = (registry.totalStorageMb / (drive.totalGb * 1024)) * 100;
        if (modelPct > 60) {
          recs.push({
            severity: 'warning',
            category: 'capacity',
            message: `Models consume ${modelPct.toFixed(0)}% of ${drive.drive} drive. Consider moving cold models to another drive.`,
          });
        }
      }
    }

    // Suggest pruning large unused models
    const largeUnloaded = registry.models
      .filter((m) => !m.loaded && m.sizeMb > 10000)
      .sort((a, b) => b.sizeMb - a.sizeMb);

    if (largeUnloaded.length > 3) {
      const totalSavings = largeUnloaded.slice(2).reduce((s, m) => s + m.sizeMb, 0);
      recs.push({
        severity: 'info',
        category: 'pruning',
        message: `${largeUnloaded.length} large models (10GB+) not currently loaded. Removing rarely used ones could free ${(totalSavings / 1024).toFixed(1)}GB.`,
        savingsMb: totalSavings,
      });
    }

    return recs;
  }

  private async getDriveCapacities(): Promise<DriveCapacity[]> {
    if (platform() === 'win32') {
      return this.getWindowsDriveCapacities();
    }
    return this.getUnixDriveCapacities();
  }

  private async getWindowsDriveCapacities(): Promise<DriveCapacity[]> {
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-Command',
        'Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N="UsedGB";E={[math]::Round($_.Used/1GB,2)}}, @{N="FreeGB";E={[math]::Round($_.Free/1GB,2)}} | ConvertTo-Json',
      ], { timeout: 10000 });

      const drives = JSON.parse(stdout);
      const arr = Array.isArray(drives) ? drives : [drives];

      return arr
        .filter((d: any) => d.FreeGB > 0 || d.UsedGB > 0)
        .map((d: any) => ({
          drive: `${d.Name}:`,
          totalGb: d.UsedGB + d.FreeGB,
          usedGb: d.UsedGB,
          freeGb: d.FreeGB,
          usedPercent: d.UsedGB + d.FreeGB > 0 ? Math.round((d.UsedGB / (d.UsedGB + d.FreeGB)) * 100) : 0,
        }));
    } catch {
      return [];
    }
  }

  private async getUnixDriveCapacities(): Promise<DriveCapacity[]> {
    try {
      const { stdout } = await execFileAsync('df', ['-BG', '--output=target,size,used,avail'], { timeout: 5000 });
      const lines = stdout.trim().split('\n').slice(1);
      return lines.map((line) => {
        const parts = line.trim().split(/\s+/);
        const totalGb = parseInt(parts[1]) || 0;
        const usedGb = parseInt(parts[2]) || 0;
        const freeGb = parseInt(parts[3]) || 0;
        return {
          drive: parts[0],
          totalGb,
          usedGb,
          freeGb,
          usedPercent: totalGb > 0 ? Math.round((usedGb / totalGb) * 100) : 0,
        };
      });
    } catch {
      return [];
    }
  }

  private getRegistrySnapshot(): RegistrySnapshot | null {
    return modelRegistry.getSnapshot();
  }
}

export const storageAdvisor = new StorageAdvisor();
