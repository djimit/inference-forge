/**
 * System Optimizer Service
 * NUMA affinity generation, Windows optimization checks, and system tuning advisor.
 * Specific to DJIMIT workstation: Threadripper 3960X, RTX 2060S, Windows 11.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { platform } from 'os';
import { hardware, type HardwareSnapshot } from './hardware.js';

const execFileAsync = promisify(execFile);

// -- Types ----------------------------------------------------------

export interface NumaConfig {
  nodeCount: number;
  coresPerNode: number;
  affinityMasks: Array<{ node: number; mask: string; cores: string }>;
  recommendations: Array<{
    scenario: string;
    command: string;
    explanation: string;
  }>;
}

export interface OptimizationCheck {
  category: 'power' | 'defender' | 'priority' | 'memory' | 'service' | 'numa';
  name: string;
  status: 'ok' | 'warning' | 'action_needed';
  current: string;
  recommended: string;
  fixCommand?: string;
}

export interface OptimizationReport {
  timestamp: number;
  platform: string;
  numa: NumaConfig;
  checks: OptimizationCheck[];
  overallScore: number; // 0-100
}

// -- Service --------------------------------------------------------

export class SystemOptimizer {

  async generateReport(): Promise<OptimizationReport> {
    const hwSnapshot = hardware.getLastSnapshot();
    const numa = this.generateNumaConfig(hwSnapshot);
    const checks = await this.runChecks(hwSnapshot);

    const okCount = checks.filter((c) => c.status === 'ok').length;
    const overallScore = checks.length > 0 ? Math.round((okCount / checks.length) * 100) : 0;

    return {
      timestamp: Date.now(),
      platform: platform(),
      numa,
      checks,
      overallScore,
    };
  }

  // -- NUMA Configuration -------------------------------------------

  private generateNumaConfig(hw: HardwareSnapshot | null): NumaConfig {
    const nodeCount = hw?.system.numaNodes || 1;
    const coresPerNode = hw?.system.coresPerNuma || (hw?.system.cpuPhysicalCores || 4);
    const totalPhysical = hw?.system.cpuPhysicalCores || 24;

    // Generate affinity masks for Windows (hex bitmasks)
    const affinityMasks: NumaConfig['affinityMasks'] = [];
    for (let node = 0; node < nodeCount; node++) {
      const startCore = node * coresPerNode;
      const endCore = Math.min(startCore + coresPerNode, totalPhysical);

      // For HT systems, each physical core has 2 logical cores
      // Threadripper maps: logical 0-5 = node 0 physical, 24-29 = node 0 HT
      let mask = BigInt(0);
      for (let c = startCore; c < endCore; c++) {
        mask |= BigInt(1) << BigInt(c);                    // physical core
        mask |= BigInt(1) << BigInt(c + totalPhysical);    // HT sibling
      }

      affinityMasks.push({
        node,
        mask: `0x${mask.toString(16).toUpperCase()}`,
        cores: `${startCore}-${endCore - 1} (physical) + ${startCore + totalPhysical}-${endCore - 1 + totalPhysical} (HT)`,
      });
    }

    // Generate practical recommendations
    const recommendations: NumaConfig['recommendations'] = [];

    if (nodeCount > 1) {
      // GPU is typically attached to NUMA node 0
      recommendations.push({
        scenario: 'Small model (GPU-heavy, e.g. phi4:14b)',
        command: `start /affinity ${affinityMasks[0].mask} ollama serve`,
        explanation: `Pin to NUMA node 0 (closest to GPU via PCIe). ${coresPerNode} physical cores + ${coresPerNode} HT threads. Minimizes PCIe↔memory latency.`,
      });

      // CPU-heavy models use all nodes
      const allNodesMask = affinityMasks.reduce((acc, m) => {
        const big = BigInt(m.mask);
        return `0x${(BigInt(acc) | big).toString(16).toUpperCase()}`;
      }, '0x0');

      recommendations.push({
        scenario: 'Large model (CPU-heavy, e.g. qwen2.5:72b)',
        command: `start /affinity ${allNodesMask} ollama serve`,
        explanation: `Use all ${nodeCount} NUMA nodes (${totalPhysical} physical cores). Model weights spread across all nodes via mmap. Cross-NUMA access is slower but more total bandwidth.`,
      });

      // Dual-backend: pin each to different NUMA nodes
      if (nodeCount >= 2) {
        recommendations.push({
          scenario: 'Dual backend (Ollama + LM Studio simultaneously)',
          command: `start /affinity ${affinityMasks[0].mask} ollama serve\nstart /affinity ${affinityMasks[1].mask} "lms server start"`,
          explanation: `Pin Ollama to NUMA node 0 (GPU-adjacent), LM Studio to node 1. Zero resource contention. Each gets ${coresPerNode} dedicated cores.`,
        });
      }

      // Batch processing
      recommendations.push({
        scenario: 'Batch processing (max throughput)',
        command: `set OLLAMA_NUM_PARALLEL=4\nstart /affinity ${allNodesMask} ollama serve`,
        explanation: `Enable 4 parallel requests across all NUMA nodes. Best for non-interactive bulk processing.`,
      });
    }

    return { nodeCount, coresPerNode, affinityMasks, recommendations };
  }

  // -- Optimization Checks ------------------------------------------

  private async runChecks(hw: HardwareSnapshot | null): Promise<OptimizationCheck[]> {
    if (platform() !== 'win32') {
      return [{ category: 'power', name: 'Platform', status: 'ok', current: platform(), recommended: 'N/A' }];
    }

    const checks: OptimizationCheck[] = [];

    // Run all checks in parallel
    const [powerPlan, defenderExclusions, ollamaProcess, pagefile] = await Promise.all([
      this.checkPowerPlan(),
      this.checkDefenderExclusions(),
      this.checkProcessPriority(),
      this.checkPagefile(hw),
    ]);

    checks.push(powerPlan, defenderExclusions, ollamaProcess, pagefile);

    // NUMA check
    const numaNodes = hw?.system.numaNodes || 1;
    checks.push({
      category: 'numa',
      name: 'NUMA Topology',
      status: numaNodes > 1 ? 'ok' : 'warning',
      current: `${numaNodes} NUMA node${numaNodes > 1 ? 's' : ''}`,
      recommended: numaNodes > 1 ? 'Multi-NUMA detected — use affinity pinning for best performance' : 'Single NUMA — no pinning needed',
    });

    // GPU check
    const gpu = hw?.gpus[0];
    if (gpu) {
      const tempStatus = gpu.temperatureCelsius !== null && gpu.temperatureCelsius > 85 ? 'warning' : 'ok';
      checks.push({
        category: 'service',
        name: 'GPU Temperature',
        status: tempStatus,
        current: gpu.temperatureCelsius !== null ? `${gpu.temperatureCelsius}°C` : 'unknown',
        recommended: tempStatus === 'warning' ? 'Reduce GPU load or improve cooling' : '< 85°C (OK)',
      });
    }

    return checks;
  }

  private async checkPowerPlan(): Promise<OptimizationCheck> {
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-Command',
        'powercfg /getactivescheme',
      ], { timeout: 5000 });

      const isHighPerf = /high performance|ultimate/i.test(stdout);
      return {
        category: 'power',
        name: 'Power Plan',
        status: isHighPerf ? 'ok' : 'action_needed',
        current: stdout.trim().replace(/^.*:\s*/, ''),
        recommended: 'High Performance or Ultimate Performance',
        fixCommand: isHighPerf ? undefined : 'powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
      };
    } catch {
      return {
        category: 'power',
        name: 'Power Plan',
        status: 'warning',
        current: 'Unable to detect',
        recommended: 'High Performance',
      };
    }
  }

  private async checkDefenderExclusions(): Promise<OptimizationCheck> {
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-Command',
        'Get-MpPreference | Select-Object -ExpandProperty ExclusionPath | ConvertTo-Json',
      ], { timeout: 5000 });

      const exclusions: string[] = JSON.parse(stdout || '[]');
      const ollamaModels = process.env.OLLAMA_MODELS || 'D:\\Ollama';
      const hasOllamaExclusion = exclusions.some((e) =>
        e.toLowerCase().includes('ollama') || e.toLowerCase() === ollamaModels.toLowerCase()
      );

      return {
        category: 'defender',
        name: 'Windows Defender Exclusions',
        status: hasOllamaExclusion ? 'ok' : 'action_needed',
        current: hasOllamaExclusion ? `${ollamaModels} excluded` : 'No model dir exclusions',
        recommended: `Exclude ${ollamaModels} to prevent AV scanning during model load`,
        fixCommand: hasOllamaExclusion ? undefined : `Add-MpPreference -ExclusionPath "${ollamaModels}"`,
      };
    } catch {
      return {
        category: 'defender',
        name: 'Windows Defender Exclusions',
        status: 'warning',
        current: 'Unable to check (requires admin)',
        recommended: 'Exclude Ollama model directory from AV scanning',
      };
    }
  }

  private async checkProcessPriority(): Promise<OptimizationCheck> {
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-Command',
        'Get-Process -Name ollama -ErrorAction SilentlyContinue | Select-Object -ExpandProperty PriorityClass',
      ], { timeout: 5000 });

      const priority = stdout.trim();
      const isAboveNormal = /above|high|realtime/i.test(priority);

      return {
        category: 'priority',
        name: 'Ollama Process Priority',
        status: priority ? (isAboveNormal ? 'ok' : 'action_needed') : 'warning',
        current: priority || 'Not running',
        recommended: 'AboveNormal during interactive inference',
        fixCommand: priority && !isAboveNormal
          ? 'Get-Process ollama | ForEach-Object { $_.PriorityClass = "AboveNormal" }'
          : undefined,
      };
    } catch {
      return {
        category: 'priority',
        name: 'Ollama Process Priority',
        status: 'warning',
        current: 'Unable to check',
        recommended: 'AboveNormal',
      };
    }
  }

  private async checkPagefile(hw: HardwareSnapshot | null): Promise<OptimizationCheck> {
    const ramGb = hw ? Math.round(hw.system.ramTotalMb / 1024) : 128;

    try {
      const { stdout } = await execFileAsync('powershell', [
        '-Command',
        '(Get-CimInstance Win32_PageFileUsage | Measure-Object -Property AllocatedBaseSize -Sum).Sum',
      ], { timeout: 5000 });

      const pagefileMb = parseInt(stdout.trim()) || 0;
      const pagefileGb = Math.round(pagefileMb / 1024);
      const isExcessive = pagefileGb > ramGb / 2;

      return {
        category: 'memory',
        name: 'Page File',
        status: isExcessive ? 'action_needed' : 'ok',
        current: `${pagefileGb}GB allocated`,
        recommended: ramGb >= 64
          ? `With ${ramGb}GB RAM, reduce pagefile to 16GB or system-managed. Large pagefiles can cause kernel to page model data.`
          : 'System-managed',
      };
    } catch {
      return {
        category: 'memory',
        name: 'Page File',
        status: 'warning',
        current: 'Unable to check',
        recommended: 'Keep minimal with 128GB RAM',
      };
    }
  }
}

export const systemOptimizer = new SystemOptimizer();
