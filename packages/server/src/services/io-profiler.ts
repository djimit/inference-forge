/**
 * I/O Bandwidth Profiler
 * Detects drive types, measures read speed, and maps Ollama model storage.
 * Inspired by flash-moe's finding that SSD streaming speed determines MoE inference speed.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync, createReadStream, readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { platform, homedir } from 'os';

const execFileAsync = promisify(execFile);

// -- Types ----------------------------------------------------------

export interface DriveInfo {
  path: string;
  type: 'nvme' | 'ssd' | 'hdd' | 'unknown';
  sizeTotalGb: number;
  sizeFreeGb: number;
}

export interface ModelStorageInfo {
  modelName: string;
  sizeMb: number;
  driveLetter: string;
  driveType: 'nvme' | 'ssd' | 'hdd' | 'unknown';
  recommendation: string;
}

export interface IoProfile {
  timestamp: number;
  ollamaModelDir: string;
  drives: DriveInfo[];
  modelStorage: ModelStorageInfo[];
  recommendations: string[];
  readBandwidthMBs: number | null;
}

// -- Detection Functions --------------------------------------------

function getOllamaModelDir(): string {
  const envDir = process.env.OLLAMA_MODELS;
  if (envDir && existsSync(envDir)) return envDir;

  if (platform() === 'win32') {
    const defaultDir = join(homedir(), '.ollama', 'models');
    if (existsSync(defaultDir)) return defaultDir;
  } else if (platform() === 'darwin') {
    const defaultDir = join(homedir(), '.ollama', 'models');
    if (existsSync(defaultDir)) return defaultDir;
  } else {
    const defaultDir = join(homedir(), '.ollama', 'models');
    if (existsSync(defaultDir)) return defaultDir;
  }

  return join(homedir(), '.ollama', 'models');
}

async function detectDriveTypes(): Promise<DriveInfo[]> {
  const drives: DriveInfo[] = [];

  if (platform() === 'win32') {
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-Command',
        'Get-PhysicalDisk | Select-Object MediaType,Size,BusType,FriendlyName | ConvertTo-Json -Compress'
      ], { timeout: 10000 });

      const parsed = JSON.parse(stdout);
      const disks = Array.isArray(parsed) ? parsed : [parsed];

      for (const disk of disks) {
        const busType = (disk.BusType || '').toString().toLowerCase();
        const mediaType = (disk.MediaType || '').toString().toLowerCase();
        const sizeGb = Math.round((disk.Size || 0) / (1024 * 1024 * 1024));

        let type: DriveInfo['type'] = 'unknown';
        if (busType.includes('nvme') || busType === '17') {
          type = 'nvme';
        } else if (mediaType.includes('ssd') || mediaType === '4') {
          type = 'ssd';
        } else if (mediaType.includes('hdd') || mediaType.includes('unspecified') || mediaType === '3') {
          type = 'hdd';
        }

        drives.push({
          path: disk.FriendlyName || 'Unknown',
          type,
          sizeTotalGb: sizeGb,
          sizeFreeGb: 0, // Would need volume mapping for this
        });
      }
    } catch {
      // Fallback: no drive detection
    }
  } else {
    try {
      const { stdout } = await execFileAsync('lsblk', ['-J', '-o', 'NAME,SIZE,ROTA,TRAN,TYPE'], { timeout: 5000 });
      const parsed = JSON.parse(stdout);
      for (const device of parsed.blockdevices || []) {
        if (device.type !== 'disk') continue;
        const type: DriveInfo['type'] = device.tran === 'nvme' ? 'nvme'
          : device.rota === '0' ? 'ssd' : 'hdd';
        drives.push({
          path: `/dev/${device.name}`,
          type,
          sizeTotalGb: parseFloat(device.size) || 0,
          sizeFreeGb: 0,
        });
      }
    } catch {
      // Fallback
    }
  }

  return drives;
}

function getDriveLetter(filePath: string): string {
  if (platform() === 'win32' && filePath.length >= 2 && filePath[1] === ':') {
    return filePath[0].toUpperCase();
  }
  return '/';
}

async function measureReadBandwidth(dirPath: string): Promise<number | null> {
  // Find a large file in the blobs directory to measure read speed
  const blobsDir = join(dirPath, 'blobs');
  if (!existsSync(blobsDir)) return null;

  try {
    const entries = await readdir(blobsDir);
    // Find the largest blob file
    let largestFile = '';
    let largestSize = 0;
    for (const entry of entries) {
      const fullPath = join(blobsDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size > largestSize) {
          largestSize = stat.size;
          largestFile = fullPath;
        }
      } catch { continue; }
    }

    if (!largestFile || largestSize < 64 * 1024 * 1024) return null; // Need at least 64MB

    // Read up to 256MB to measure bandwidth
    const readSize = Math.min(largestSize, 256 * 1024 * 1024);
    const start = performance.now();
    let bytesRead = 0;

    return new Promise<number | null>((resolve) => {
      const stream = createReadStream(largestFile, {
        highWaterMark: 64 * 1024, // 64KB chunks
        end: readSize - 1,
      });

      stream.on('data', (chunk: Buffer) => {
        bytesRead += chunk.length;
      });

      stream.on('end', () => {
        const elapsed = (performance.now() - start) / 1000; // seconds
        const mbPerSec = elapsed > 0 ? (bytesRead / (1024 * 1024)) / elapsed : 0;
        resolve(Math.round(mbPerSec));
      });

      stream.on('error', () => {
        resolve(null);
      });
    });
  } catch {
    return null;
  }
}

// -- Service --------------------------------------------------------

export class IoProfiler {
  private lastProfile: IoProfile | null = null;
  private benchmarkRunning = false;

  async profile(): Promise<IoProfile> {
    const modelDir = getOllamaModelDir();
    const drives = await detectDriveTypes();

    // Map models to storage locations
    const modelStorage: ModelStorageInfo[] = [];
    const recommendations: string[] = [];

    const driveLetter = getDriveLetter(modelDir);

    // Determine the drive type for the model directory
    let modelDriveType: DriveInfo['type'] = 'unknown';
    // On Windows, try to match drive letter to physical disk
    if (platform() === 'win32' && drives.length > 0) {
      // Heuristic: if there's an NVMe drive, check if model dir is on it
      const hasNvme = drives.some((d) => d.type === 'nvme');
      const hasHdd = drives.some((d) => d.type === 'hdd');

      // Try to detect via PowerShell volume mapping
      try {
        const { stdout } = await execFileAsync('powershell', [
          '-Command',
          `Get-Partition -DriveLetter ${driveLetter} | Get-Disk | Select-Object BusType,MediaType | ConvertTo-Json -Compress`
        ], { timeout: 5000 });
        const diskInfo = JSON.parse(stdout);
        const busType = (diskInfo.BusType || '').toString().toLowerCase();
        const mediaType = (diskInfo.MediaType || '').toString().toLowerCase();
        if (busType.includes('nvme') || busType === '17') modelDriveType = 'nvme';
        else if (mediaType.includes('ssd') || mediaType === '4') modelDriveType = 'ssd';
        else modelDriveType = 'hdd';
      } catch {
        // Can't determine, use heuristic
        modelDriveType = hasNvme ? 'nvme' : hasHdd ? 'hdd' : 'unknown';
      }
    }

    // Check model blobs
    const manifestsDir = join(modelDir, 'manifests');
    if (existsSync(manifestsDir)) {
      try {
        const registries = await readdir(manifestsDir);
        for (const registry of registries) {
          const regPath = join(manifestsDir, registry);
          const libs = await readdir(regPath).catch(() => [] as string[]);
          for (const lib of libs) {
            const libPath = join(regPath, lib);
            const models = await readdir(libPath).catch(() => [] as string[]);
            for (const modelName of models) {
              const tagsPath = join(libPath, modelName);
              const tags = await readdir(tagsPath).catch(() => [] as string[]);
              for (const tag of tags) {
                const fullName = `${lib}/${modelName}:${tag}`;
                let sizeMb = 0;
                try {
                  const manifestPath = join(tagsPath, tag);
                  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
                  const totalBytes = (manifest.layers || []).reduce(
                    (sum: number, layer: { size?: number }) => sum + (layer.size || 0), 0
                  );
                  sizeMb = Math.round(totalBytes / (1024 * 1024));
                } catch {
                  // Manifest unreadable — leave at 0
                }
                modelStorage.push({
                  modelName: fullName,
                  sizeMb,
                  driveLetter,
                  driveType: modelDriveType,
                  recommendation: modelDriveType === 'hdd'
                    ? 'Move to NVMe for faster loading'
                    : modelDriveType === 'nvme'
                    ? 'Optimal placement'
                    : 'Consider NVMe for best performance',
                });
              }
            }
          }
        }
      } catch {
        // Can't enumerate models
      }
    }

    // Generate recommendations
    if (modelDriveType === 'hdd') {
      recommendations.push('Models stored on HDD — expect 10-20x slower model loading compared to NVMe.');
      recommendations.push('Move Ollama models directory to NVMe: set OLLAMA_MODELS environment variable.');
    } else if (modelDriveType === 'nvme') {
      recommendations.push('Models stored on NVMe — optimal for fast model loading.');
    }

    if (drives.some((d) => d.type === 'nvme') && modelDriveType !== 'nvme') {
      recommendations.push('NVMe drive detected but models are not on it. Consider migrating for faster loads.');
    }

    const profile: IoProfile = {
      timestamp: Date.now(),
      ollamaModelDir: modelDir,
      drives,
      modelStorage,
      recommendations,
      readBandwidthMBs: this.lastProfile?.readBandwidthMBs || null,
    };

    this.lastProfile = profile;
    return profile;
  }

  async runBenchmark(): Promise<number | null> {
    if (this.benchmarkRunning) return null;
    this.benchmarkRunning = true;

    try {
      const modelDir = getOllamaModelDir();
      const bandwidth = await measureReadBandwidth(modelDir);
      if (this.lastProfile) {
        this.lastProfile.readBandwidthMBs = bandwidth;
      }
      return bandwidth;
    } finally {
      this.benchmarkRunning = false;
    }
  }

  getLastProfile(): IoProfile | null {
    return this.lastProfile;
  }

  isBenchmarkRunning(): boolean {
    return this.benchmarkRunning;
  }
}

export const ioProfiler = new IoProfiler();
