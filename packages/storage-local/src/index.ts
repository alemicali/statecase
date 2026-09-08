import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export { LocalFileMutex, LocalMutexBusy } from "./mutex.js";

export type OperationState = "queued" | "running" | "committed";

export interface NewOperation {
  id: string;
  kind: string;
  payload: unknown;
}

export interface StoredOperation extends NewOperation {
  state: OperationState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  lastError: string | null;
  resultRevisionId: string | null;
}

interface OperationRow {
  id: string;
  kind: string;
  payload_json: string;
  state: OperationState;
  attempts: number;
  created_at: number;
  updated_at: number;
  lease_owner: string | null;
  lease_until: number | null;
  last_error: string | null;
  result_revision_id: string | null;
}

const SCHEMA_VERSION = 1;

export class LocalStateStore {
  readonly #database: Database.Database;
  #closed = false;

  constructor(path: string) {
    if (path.length === 0) throw new TypeError("database path is required");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = new Database(path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#migrate();
  }

  journalMode(): string {
    return String(this.#database.pragma("journal_mode", { simple: true })).toLowerCase();
  }

  schemaVersion(): number {
    return Number(this.#database.pragma("user_version", { simple: true }));
  }

  enqueue(operation: NewOperation): boolean {
    validateOperation(operation);
    const now = Date.now();
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO operations (
        id, kind, payload_json, state, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', 0, ?, ?)
    `).run(operation.id, operation.kind, JSON.stringify(operation.payload), now, now);
    return result.changes === 1;
  }

  pending(): StoredOperation[] {
    const rows = this.#database.prepare(`
      SELECT * FROM operations
      WHERE state != 'committed'
      ORDER BY created_at, id
    `).all() as OperationRow[];
    return rows.map(mapOperation);
  }

  getOperation(id: string): StoredOperation | undefined {
    const row = this.#database.prepare("SELECT * FROM operations WHERE id = ?").get(id) as OperationRow | undefined;
    return row ? mapOperation(row) : undefined;
  }

  claimNext(leaseOwner: string, leaseDurationMs: number, now = Date.now()): StoredOperation | undefined {
    if (leaseOwner.length === 0 || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new TypeError("a lease owner and positive duration are required");
    }
    return this.#database.transaction(() => {
      const row = this.#database.prepare(`
        SELECT * FROM operations
        WHERE state = 'queued' OR (state = 'running' AND lease_until <= ?)
        ORDER BY created_at, id
        LIMIT 1
      `).get(now) as OperationRow | undefined;
      if (!row) return undefined;
      this.#database.prepare(`
        UPDATE operations
        SET state = 'running', lease_owner = ?, lease_until = ?, updated_at = ?
        WHERE id = ?
      `).run(leaseOwner, now + leaseDurationMs, now, row.id);
      return this.getOperation(row.id);
    })();
  }

  retry(id: string, redactedError: string): void {
    requireBoundedText(redactedError, "redacted error", 2048);
    const result = this.#database.prepare(`
      UPDATE operations
      SET state = 'queued', attempts = attempts + 1, lease_owner = NULL,
          lease_until = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND state = 'running'
    `).run(redactedError, Date.now(), id);
    if (result.changes !== 1) throw new Error("operation is not running");
  }

  commit(id: string, resultRevisionId: string): void {
    requireBoundedText(resultRevisionId, "revision ID", 256);
    const result = this.#database.prepare(`
      UPDATE operations
      SET state = 'committed', result_revision_id = ?, lease_owner = NULL,
          lease_until = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND state = 'running'
    `).run(resultRevisionId, Date.now(), id);
    if (result.changes !== 1) throw new Error("operation is not running");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #migrate(): void {
    const current = this.schemaVersion();
    if (current > SCHEMA_VERSION) throw new Error(`local database schema ${current} is newer than supported ${SCHEMA_VERSION}`);
    if (current === SCHEMA_VERSION) return;
    this.#database.transaction(() => {
      this.#database.exec(`
        CREATE TABLE operations (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'committed')),
          attempts INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          lease_owner TEXT,
          lease_until INTEGER,
          last_error TEXT,
          result_revision_id TEXT
        ) STRICT;
        CREATE INDEX operations_pending ON operations(state, created_at, id);
      `);
      this.#database.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }
}

function validateOperation(operation: NewOperation): void {
  requireBoundedText(operation.id, "operation ID", 256);
  requireBoundedText(operation.kind, "operation kind", 128);
  const serialized = JSON.stringify(operation.payload);
  if (serialized === undefined) throw new TypeError("operation payload must be JSON serializable");
}

function requireBoundedText(value: string, name: string, maximum: number): void {
  if (value.length === 0 || value.length > maximum) throw new TypeError(`${name} is invalid`);
}

function mapOperation(row: OperationRow): StoredOperation {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown,
    state: row.state,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    resultRevisionId: row.result_revision_id,
  };
}
