/**
 * Centralised configuration — everything comes from the environment.
 * Secrets are NEVER logged and never appear in this file.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import 'dotenv/config';

function req(name: string, val: string | undefined): string {
  if (!val || val.trim() === '') {
    throw new Error(`Missing required env var ${name}`);
  }
  return val.trim();
}

function opt(name: string, def: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : def;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (!v || v.trim() === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got ${v}`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (!v || v.trim() === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

export interface CircuitInfo {
  network: string;
  circuits: Record<string, { vkHash: string; artifacts: { wasm: string; zkey: string } }>;
}

const artifactsDir = path.resolve(opt('ARTIFACTS_DIR', './artifacts'));

function loadCircuitInfo(): CircuitInfo {
  const p = path.join(artifactsDir, 'circuit-info.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as CircuitInfo;
}

export const config = {
  hmacSecret: req('AGENT_GAMES_HMAC_SECRET', process.env.AGENT_GAMES_HMAC_SECRET),

  server: {
    host: opt('HOST', '0.0.0.0'),
    port: num('PORT', 8080),
    agentPath: opt('AGENT_PATH', '/agent'),
    tlsCertPath: process.env.TLS_CERT_PATH || undefined,
    tlsKeyPath: process.env.TLS_KEY_PATH || undefined,
  },

  circuit: {
    artifactsDir,
    wasmPath: path.join(artifactsDir, 'gatekeeper.wasm'),
    zkeyPath: path.join(artifactsDir, 'gatekeeper_final.zkey'),
    // Authoritative vk_hash published by the platform (checklist #1/#2).
    expectedVkHash: opt(
      'EXPECTED_VK_HASH',
      loadCircuitInfo().circuits.gatekeeper.vkHash,
    ).toLowerCase(),
  },

  // task_id -> field mapping (unconfirmed; see .env.example)
  taskIdFieldMode: ((): 'keccak' | 'digits' | 'numeric' | 'zero' => {
    const m = opt('TASKID_FIELD_MODE', 'keccak');
    if (!['keccak', 'digits', 'numeric', 'zero'].includes(m)) {
      throw new Error(`Invalid TASKID_FIELD_MODE: ${m}`);
    }
    return m as 'keccak' | 'digits' | 'numeric' | 'zero';
  })(),

  kurier: {
    url: opt('KURIER_URL', 'https://api.kurier.xyz'),
    apiKey: process.env.KURIER_API_KEY || '',
    finalizeTimeoutMs: num('KURIER_FINALIZE_TIMEOUT_MS', 35000),
    pollIntervalMs: num('KURIER_POLL_INTERVAL_MS', 2000),
  },

  approvalRequireFinalized: bool('APPROVAL_REQUIRE_FINALIZED', true),

  behaviour: {
    taskDeadlineMs: num('TASK_DEADLINE_MS', 60000),
    // Internal budget: answer before the platform's 60s hard deadline.
    internalDeadlineMs: num('TASK_DEADLINE_MS', 60000) - 4000,
    clockSkewSeconds: num('CLOCK_SKEW_SECONDS', 300),
    reuseStorePath: path.resolve(opt('REUSE_STORE_PATH', './data/seen-proof-tx.json')),
    logLevel: opt('LOG_LEVEL', 'info'),
  },
};

export type Config = typeof config;
