/**
 * Persistent store of seen proof references (checklist #4: "The proof
 * reference has not already been used for another task").
 *
 * Simple atomic-write JSON file — good enough for a single-process agent and
 * survives restarts, which an in-memory map would not.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

interface StoreShape {
  seen: Record<string, { task_id: string; first_seen: string }>;
}

export class ReuseStore {
  private seen = new Map<string, { task_id: string; first_seen: string }>();
  private readonly file: string;
  private loaded = false;

  constructor(file?: string) {
    this.file = file ?? config.behaviour.reuseStorePath;
  }

  private load(): void {
    if (this.loaded) return;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as StoreShape;
      for (const [k, v] of Object.entries(parsed.seen ?? {})) this.seen.set(k, v);
    } catch {
      // Missing or unreadable file -> start empty (fresh deployment).
    }
    this.loaded = true;
  }

  private persist(): void {
    const shape: StoreShape = {
      seen: Object.fromEntries(this.seen),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(shape, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  hasSeen(proofTx: string): boolean {
    this.load();
    return this.seen.has(proofTx);
  }

  /** Record a proof reference as consumed by a task. Idempotent per key. */
  record(proofTx: string, taskId: string): void {
    this.load();
    const key = proofTx.trim().toLowerCase();
    if (!key || this.seen.has(key)) return;
    this.seen.set(key, { task_id: taskId, first_seen: new Date().toISOString() });
    try {
      this.persist();
    } catch (e) {
      // Persistence failure must not crash the task; log loudly.
      log.error('reuse store persist failed', { error: String((e as Error).message) });
    }
  }

  get size(): number {
    this.load();
    return this.seen.size;
  }
}
