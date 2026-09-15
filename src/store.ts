import type Database from "better-sqlite3";
import type { EventLogEntry, EventOutcome, Release, ReleaseEventType, ReleaseState } from "./types.js";
import { ReleaseNotFoundError } from "./errors.js";

const DATE_KEYS = new Set(["createdAt", "updatedAt", "approvedAt", "startedAt", "completedAt", "requestedAt"]);

function dateReviver(key: string, value: unknown): unknown {
  if (DATE_KEYS.has(key) && typeof value === "string") {
    return new Date(value);
  }
  return value;
}

function serializeRelease(release: Release): string {
  return JSON.stringify(release);
}

function deserializeRelease(data: string): Release {
  return JSON.parse(data, dateReviver) as Release;
}

export class ReleaseStore {
  constructor(private readonly db: Database.Database) {}

  insertRelease(release: Release): void {
    this.db
      .prepare(
        `INSERT INTO releases (id, version, state, environment, created_by, created_at, updated_at, data)
         VALUES (@id, @version, @state, @environment, @createdBy, @createdAt, @updatedAt, @data)`
      )
      .run({
        id: release.id,
        version: release.version,
        state: release.state,
        environment: release.environment,
        createdBy: release.createdBy,
        createdAt: release.createdAt.toISOString(),
        updatedAt: release.updatedAt.toISOString(),
        data: serializeRelease(release),
      });
  }

  saveRelease(release: Release): void {
    this.db
      .prepare(
        `UPDATE releases SET state = @state, updated_at = @updatedAt, data = @data WHERE id = @id`
      )
      .run({
        id: release.id,
        state: release.state,
        updatedAt: release.updatedAt.toISOString(),
        data: serializeRelease(release),
      });
  }

  getRelease(id: string): Release {
    const row = this.db.prepare(`SELECT data FROM releases WHERE id = ?`).get(id) as { data: string } | undefined;
    if (!row) throw new ReleaseNotFoundError(id);
    return deserializeRelease(row.data);
  }

  listReleases(): Release[] {
    const rows = this.db.prepare(`SELECT data FROM releases ORDER BY created_at DESC`).all() as { data: string }[];
    return rows.map((r) => deserializeRelease(r.data));
  }

  appendEvent(entry: {
    releaseId: string;
    type: ReleaseEventType;
    payload: Record<string, unknown> | undefined;
    actor: string;
    fromState: ReleaseState;
    toState: ReleaseState | null;
    outcome: EventOutcome;
    reason?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO events (release_id, type, payload, actor, from_state, to_state, outcome, reason, created_at)
         VALUES (@releaseId, @type, @payload, @actor, @fromState, @toState, @outcome, @reason, @createdAt)`
      )
      .run({
        releaseId: entry.releaseId,
        type: entry.type,
        payload: entry.payload ? JSON.stringify(entry.payload) : null,
        actor: entry.actor,
        fromState: entry.fromState,
        toState: entry.toState,
        outcome: entry.outcome,
        reason: entry.reason ?? null,
        createdAt: new Date().toISOString(),
      });
  }

  getEventLog(releaseId: string): EventLogEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE release_id = ? ORDER BY seq ASC`)
      .all(releaseId) as {
      seq: number;
      release_id: string;
      type: ReleaseEventType;
      payload: string | null;
      actor: string;
      from_state: ReleaseState;
      to_state: ReleaseState | null;
      outcome: EventOutcome;
      reason: string | null;
      created_at: string;
    }[];

    return rows.map((r) => ({
      seq: r.seq,
      releaseId: r.release_id,
      type: r.type,
      payload: r.payload ? JSON.parse(r.payload) : undefined,
      actor: r.actor,
      fromState: r.from_state,
      toState: r.to_state,
      outcome: r.outcome,
      reason: r.reason ?? undefined,
      createdAt: new Date(r.created_at),
    }));
  }
}
