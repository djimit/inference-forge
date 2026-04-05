/**
 * SQLite Persistence Layer
 * Stores benchmark history, hardware snapshots, and alert history.
 * Falls back gracefully to no-op if better-sqlite3 fails to load.
 */

import { join } from 'path';
import { createRequire } from 'module';

// Dynamic import with fallback for native module issues
let Database: any = null;
try {
  const require = createRequire(import.meta.url);
  Database = require('better-sqlite3');
} catch {
  console.warn('[Database] better-sqlite3 not available — running without persistence');
}

// -- Service --------------------------------------------------------

export class DatabaseService {
  private db: any = null;
  private enabled = false;

  constructor(dbPath?: string) {
    if (!Database) return;

    try {
      const path = dbPath || join(process.cwd(), 'inference-forge.db');
      this.db = new Database(path);
      this.db.pragma('journal_mode = WAL');
      this.migrate();
      this.enabled = true;
      console.log(`[Database] SQLite ready at ${path}`);
    } catch (err) {
      console.warn('[Database] Failed to initialize:', err);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS benchmark_runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        model TEXT NOT NULL,
        config_json TEXT,
        summary_json TEXT NOT NULL,
        results_json TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hardware_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alert_history (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        model TEXT,
        value REAL,
        threshold REAL,
        acknowledged INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model ON benchmark_runs(model);
      CREATE INDEX IF NOT EXISTS idx_benchmark_runs_mode ON benchmark_runs(mode);
      CREATE INDEX IF NOT EXISTS idx_hardware_snapshots_ts ON hardware_snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_alert_history_ts ON alert_history(timestamp);

      CREATE TABLE IF NOT EXISTS cost_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        agent TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        estimated_cost_usd REAL NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cost_samples_ts ON cost_samples(timestamp);
      CREATE INDEX IF NOT EXISTS idx_cost_samples_provider ON cost_samples(provider);

      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        parameter_size TEXT,
        quantization TEXT,
        architecture TEXT,
        tok_s_gpu REAL,
        tok_s_cpu REAL,
        prompt_tok_s REAL,
        first_token_ms REAL,
        vram_usage_mb REAL,
        ram_usage_mb REAL,
        optimal_gpu_layers INTEGER,
        optimal_threads INTEGER,
        quality_proxy REAL,
        max_context_tested INTEGER,
        benchmarked_at INTEGER NOT NULL,
        UNIQUE(backend, model_id)
      );

      CREATE INDEX IF NOT EXISTS idx_model_profiles_backend ON model_profiles(backend);
    `);
  }

  // -- Benchmark Methods --------------------------------------------

  saveBenchmarkRun(summary: any): void {
    if (!this.enabled) return;
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO benchmark_runs (id, mode, model, config_json, summary_json, results_json, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        summary.id || `bench-${Date.now()}`,
        summary.mode || 'kv-cache',
        summary.model,
        JSON.stringify(summary.config || {}),
        JSON.stringify(summary.summary || []),
        JSON.stringify(summary.results || []),
        summary.startedAt,
        summary.completedAt
      );
    } catch (err) {
      console.error('[Database] saveBenchmarkRun error:', err);
    }
  }

  getBenchmarkRun(id: string): any | null {
    if (!this.enabled) return null;
    try {
      const row = this.db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(id);
      if (!row) return null;
      return {
        ...row,
        summary: JSON.parse(row.summary_json),
        results: JSON.parse(row.results_json),
        config: JSON.parse(row.config_json || '{}'),
      };
    } catch {
      return null;
    }
  }

  listBenchmarkRuns(limit = 50, mode?: string): any[] {
    if (!this.enabled) return [];
    try {
      const sql = mode
        ? 'SELECT id, mode, model, started_at, completed_at, summary_json FROM benchmark_runs WHERE mode = ? ORDER BY completed_at DESC LIMIT ?'
        : 'SELECT id, mode, model, started_at, completed_at, summary_json FROM benchmark_runs ORDER BY completed_at DESC LIMIT ?';
      const rows = mode ? this.db.prepare(sql).all(mode, limit) : this.db.prepare(sql).all(limit);
      return rows.map((r: any) => ({
        id: r.id,
        mode: r.mode,
        model: r.model,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        summary: JSON.parse(r.summary_json),
      }));
    } catch {
      return [];
    }
  }

  // -- Hardware Methods ----------------------------------------------

  saveHardwareSnapshot(snapshot: any): void {
    if (!this.enabled) return;
    try {
      this.db.prepare(
        'INSERT INTO hardware_snapshots (timestamp, snapshot_json) VALUES (?, ?)'
      ).run(snapshot.timestamp, JSON.stringify(snapshot));
    } catch (err) {
      console.error('[Database] saveHardwareSnapshot error:', err);
    }
  }

  getHardwareHistory(since: number, limit = 100): any[] {
    if (!this.enabled) return [];
    try {
      const rows = this.db.prepare(
        'SELECT * FROM hardware_snapshots WHERE timestamp > ? ORDER BY timestamp DESC LIMIT ?'
      ).all(since, limit);
      return rows.map((r: any) => JSON.parse(r.snapshot_json));
    } catch {
      return [];
    }
  }

  // -- Alert Methods -------------------------------------------------

  saveAlert(alert: any): void {
    if (!this.enabled) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO alert_history (id, timestamp, severity, category, title, message, model, value, threshold, acknowledged)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        alert.id,
        alert.timestamp,
        alert.severity,
        alert.category,
        alert.title,
        alert.message,
        alert.model || null,
        alert.value ?? null,
        alert.threshold ?? null,
        alert.acknowledged ? 1 : 0
      );
    } catch (err) {
      console.error('[Database] saveAlert error:', err);
    }
  }

  getAlertHistory(limit = 100, since?: number): any[] {
    if (!this.enabled) return [];
    try {
      const sql = since
        ? 'SELECT * FROM alert_history WHERE timestamp > ? ORDER BY timestamp DESC LIMIT ?'
        : 'SELECT * FROM alert_history ORDER BY timestamp DESC LIMIT ?';
      const rows = since ? this.db.prepare(sql).all(since, limit) : this.db.prepare(sql).all(limit);
      return rows.map((r: any) => ({
        ...r,
        acknowledged: !!r.acknowledged,
      }));
    } catch {
      return [];
    }
  }

  // -- Model Profile Methods ------------------------------------------

  saveModelProfile(profile: {
    id: string;
    backend: string;
    modelId: string;
    displayName: string;
    parameterSize?: string;
    quantization?: string;
    architecture?: string;
    tokSGpu?: number;
    tokSCpu?: number;
    promptTokS?: number;
    firstTokenMs?: number;
    vramUsageMb?: number;
    ramUsageMb?: number;
    optimalGpuLayers?: number;
    optimalThreads?: number;
    qualityProxy?: number;
    maxContextTested?: number;
    benchmarkedAt: number;
  }): void {
    if (!this.enabled) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO model_profiles
        (id, backend, model_id, display_name, parameter_size, quantization, architecture,
         tok_s_gpu, tok_s_cpu, prompt_tok_s, first_token_ms, vram_usage_mb, ram_usage_mb,
         optimal_gpu_layers, optimal_threads, quality_proxy, max_context_tested, benchmarked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        profile.id,
        profile.backend,
        profile.modelId,
        profile.displayName,
        profile.parameterSize || null,
        profile.quantization || null,
        profile.architecture || null,
        profile.tokSGpu ?? null,
        profile.tokSCpu ?? null,
        profile.promptTokS ?? null,
        profile.firstTokenMs ?? null,
        profile.vramUsageMb ?? null,
        profile.ramUsageMb ?? null,
        profile.optimalGpuLayers ?? null,
        profile.optimalThreads ?? null,
        profile.qualityProxy ?? null,
        profile.maxContextTested ?? null,
        profile.benchmarkedAt
      );
    } catch (err) {
      console.error('[Database] saveModelProfile error:', err);
    }
  }

  getModelProfile(backend: string, modelId: string): any | null {
    if (!this.enabled) return null;
    try {
      return this.db.prepare(
        'SELECT * FROM model_profiles WHERE backend = ? AND model_id = ?'
      ).get(backend, modelId) || null;
    } catch {
      return null;
    }
  }

  getAllModelProfiles(): any[] {
    if (!this.enabled) return [];
    try {
      return this.db.prepare(
        'SELECT * FROM model_profiles ORDER BY benchmarked_at DESC'
      ).all();
    } catch {
      return [];
    }
  }

  // -- Cost Methods ---------------------------------------------------

  saveCostSample(sample: {
    timestamp: number;
    provider: string;
    model: string;
    agent?: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  }): void {
    if (!this.enabled) return;
    try {
      this.db.prepare(`
        INSERT INTO cost_samples (timestamp, provider, model, agent, input_tokens, output_tokens, estimated_cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        sample.timestamp,
        sample.provider,
        sample.model,
        sample.agent || null,
        sample.inputTokens,
        sample.outputTokens,
        sample.estimatedCostUsd
      );
    } catch (err) {
      console.error('[Database] saveCostSample error:', err);
    }
  }

  getCostSamples(since: number, limit = 500): any[] {
    if (!this.enabled) return [];
    try {
      return this.db.prepare(
        'SELECT * FROM cost_samples WHERE timestamp > ? ORDER BY timestamp DESC LIMIT ?'
      ).all(since, limit).map((r: any) => ({
        timestamp: r.timestamp,
        provider: r.provider,
        model: r.model,
        agent: r.agent,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        estimatedCostUsd: r.estimated_cost_usd,
      }));
    } catch {
      return [];
    }
  }

  // -- Cleanup -------------------------------------------------------

  close(): void {
    if (this.db) {
      try { this.db.close(); } catch {}
    }
  }
}

export const database = new DatabaseService();
