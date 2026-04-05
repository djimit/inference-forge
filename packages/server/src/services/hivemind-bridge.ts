/**
 * Hivemind Bridge Service
 * Publishes inference performance profiles, model recommendations, and
 * hardware snapshots to the Hivemind universal memory layer.
 *
 * Uses Python subprocess to call Hivemind's store API directly,
 * since Hivemind runs as an MCP stdio server (not HTTP).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { perfProfiler, type ModelProfile } from './perf-profiler.js';
import { hardware, type HardwareSnapshot } from './hardware.js';
import { routeAdvisor } from './route-advisor.js';

const execFileAsync = promisify(execFile);

// -- Types ----------------------------------------------------------

export interface PublishResult {
  published: number;
  failed: number;
  errors: string[];
}

// -- Service --------------------------------------------------------

export class HivemindBridge {
  private pythonPath = 'python';
  private hivemindSrc = 'C:\\Users\\dutch\\Projects\\hivemind\\src';

  /**
   * Store a memory in Hivemind via Python subprocess.
   * Calls hivemind.core.store directly.
   */
  private async storeMemory(content: string, tags: string[], project = 'inference-forge', source = 'inference-forge'): Promise<boolean> {
    const script = `
import sys, os
os.environ.setdefault('PYTHONPATH', '${this.hivemindSrc.replace(/\\/g, '\\\\')}')
sys.path.insert(0, '${this.hivemindSrc.replace(/\\/g, '\\\\')}')
from hivemind.core import store_memory
result = store_memory(
    content=${JSON.stringify(content)},
    source="${source}",
    tags=${JSON.stringify(tags)},
    agent="inference-forge",
    project="${project}",
    role="system"
)
print("OK" if result else "FAIL")
`;

    try {
      const { stdout } = await execFileAsync(this.pythonPath, ['-X', 'utf8', '-c', script], {
        timeout: 15000,
        env: { ...process.env, PYTHONPATH: this.hivemindSrc },
      });
      return stdout.trim().startsWith('OK');
    } catch (err) {
      console.error('[HivemindBridge] Store error:', err);
      return false;
    }
  }

  /** Publish all performance profiles to Hivemind */
  async publishProfiles(): Promise<PublishResult> {
    const profiles = perfProfiler.getProfiles();
    let published = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const profile of profiles) {
      const tokS = profile.tokSGpu || profile.tokSCpu || 0;
      const quality = profile.qualityProxy || 0;

      const content = [
        `Model Performance Profile: ${profile.displayName}`,
        `Backend: ${profile.backend}`,
        `Parameters: ${profile.parameterSize} | Architecture: ${profile.architecture} | Quantization: ${profile.quantization}`,
        `Speed: ${tokS} tok/s${profile.tokSGpu ? ' (GPU)' : profile.tokSCpu ? ' (CPU)' : ''}`,
        profile.promptTokS ? `Prompt eval: ${profile.promptTokS} tok/s` : null,
        profile.firstTokenMs ? `First token: ${profile.firstTokenMs}ms` : null,
        profile.vramUsageMb ? `VRAM usage: ${profile.vramUsageMb}MB` : null,
        `Quality proxy: ${(quality * 100).toFixed(0)}%`,
        `Benchmarked: ${new Date(profile.benchmarkedAt).toISOString()}`,
        `Hardware: AMD Threadripper 3960X, 128GB RAM, RTX 2060S 8GB, 4 NUMA nodes`,
      ].filter(Boolean).join('\n');

      const tags = [
        'model-profile', 'benchmark', 'inference',
        profile.backend, profile.architecture,
        tokS > 20 ? 'fast' : tokS > 5 ? 'moderate' : 'slow',
        quality > 0.7 ? 'high-quality' : quality > 0.4 ? 'medium-quality' : 'low-quality',
      ];

      const ok = await this.storeMemory(content, tags);
      if (ok) published++;
      else { failed++; errors.push(`Failed to store profile for ${profile.displayName}`); }
    }

    return { published, failed, errors };
  }

  /** Publish routing recommendations to Hivemind */
  async publishRoutingGuide(): Promise<boolean> {
    const profiles = perfProfiler.getProfiles();
    if (profiles.length === 0) return false;

    // Build a routing guide from profiles
    const lines = [
      'Inference Forge — Local Model Routing Guide',
      `Generated: ${new Date().toISOString()}`,
      `Hardware: Threadripper 3960X (24C/48T, 4 NUMA), 128GB RAM, RTX 2060S 8GB`,
      '',
      'Available models ranked by speed:',
    ];

    const sorted = [...profiles]
      .map((p) => ({ ...p, tokS: p.tokSGpu || p.tokSCpu || 0 }))
      .sort((a, b) => b.tokS - a.tokS);

    for (const p of sorted) {
      lines.push(`  ${p.displayName} (${p.backend}): ${p.tokS} tok/s, ${p.parameterSize} ${p.quantization}`);
    }

    lines.push('');
    lines.push('Routing recommendations:');
    lines.push('  Quick chat/coding: Use fastest GPU-loaded model');
    lines.push('  Complex reasoning: Use largest available model (accept slower speed)');
    lines.push('  Embeddings: nomic-embed-text (tiny, fast)');
    lines.push('  Batch analysis: Queue for large model during off-peak');

    const content = lines.join('\n');
    return this.storeMemory(content, [
      'routing-guide', 'inference', 'model-selection', 'recommendation',
    ]);
  }

  /** Publish current hardware snapshot to Hivemind */
  async publishHardwareSnapshot(): Promise<boolean> {
    const hw = hardware.getLastSnapshot();
    if (!hw) return false;

    const content = [
      'DJIMIT Workstation Hardware Snapshot',
      `CPU: ${hw.system.cpuModel}`,
      `Cores: ${hw.system.cpuPhysicalCores} physical / ${hw.system.cpuCores} logical`,
      `NUMA: ${hw.system.numaNodes} nodes, ${hw.system.coresPerNuma} cores each`,
      `RAM: ${Math.round(hw.system.ramTotalMb / 1024)}GB total, ${Math.round(hw.system.ramFreeMb / 1024)}GB free`,
      `GPU: ${hw.gpus.map((g) => `${g.name} (${Math.round(g.vramTotalMb / 1024)}GB VRAM, ${g.temperatureCelsius}°C)`).join(', ') || 'none'}`,
      `PCIe: Gen ${hw.system.pcieGeneration || '?'} x${hw.system.pcieLanes || '?'}`,
      `Snapshot: ${new Date(hw.timestamp).toISOString()}`,
    ].join('\n');

    return this.storeMemory(content, [
      'hardware', 'workstation', 'djimit', 'gpu', 'cpu', 'ram',
    ]);
  }

  /** Publish all — profiles + routing guide + hardware */
  async publishAll(): Promise<PublishResult> {
    const profileResult = await this.publishProfiles();
    const routingOk = await this.publishRoutingGuide();
    const hwOk = await this.publishHardwareSnapshot();

    return {
      published: profileResult.published + (routingOk ? 1 : 0) + (hwOk ? 1 : 0),
      failed: profileResult.failed + (routingOk ? 0 : 1) + (hwOk ? 0 : 1),
      errors: profileResult.errors,
    };
  }
}

export const hivemindBridge = new HivemindBridge();
