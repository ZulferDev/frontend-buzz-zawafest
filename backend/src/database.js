import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { createEmptyState, validateState } from "./state.js";

export class RevisionConflictError extends Error {
  constructor(latest) {
    super("State telah diperbarui oleh klien lain.");
    this.name = "RevisionConflictError";
    this.latest = latest;
  }
}

export class StateValidationError extends Error {
  constructor(issues) {
    super("State tidak valid.");
    this.name = "StateValidationError";
    this.issues = issues;
  }
}

export function createStateStore(filename = ":memory:") {
  if (filename !== ":memory:") mkdirSync(dirname(resolve(filename)), { recursive: true });

  const database = new Database(filename);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS competition_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  database.prepare(`
    INSERT OR IGNORE INTO competition_state (singleton, revision, state_json, updated_at)
    VALUES (1, 0, ?, ?)
  `).run(JSON.stringify(createEmptyState()), Date.now());

  const readRow = database.prepare(
    "SELECT revision, state_json FROM competition_state WHERE singleton = 1",
  );
  const updateRow = database.prepare(`
    UPDATE competition_state
    SET revision = ?, state_json = ?, updated_at = ?
    WHERE singleton = 1
  `);

  function read() {
    const row = readRow.get();
    return { revision: row.revision, state: JSON.parse(row.state_json) };
  }

  function replace(state, expectedRevision) {
    const issues = validateState(state);
    if (issues.length) throw new StateValidationError(issues);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new StateValidationError(["expectedRevision harus berupa bilangan bulat nol atau lebih."]);
    }

    return database.transaction(() => {
      const current = read();
      if (current.revision !== expectedRevision) throw new RevisionConflictError(current);

      const next = structuredClone(state);
      next.updatedAt = Date.now();
      const revision = current.revision + 1;
      updateRow.run(revision, JSON.stringify(next), next.updatedAt);
      return { revision, state: next };
    }).immediate();
  }

  function claimBuzzer(teamId) {
    if (typeof teamId !== "string" || !teamId.trim() || teamId.length > 128) {
      throw new StateValidationError(["teamId harus berupa string yang tidak kosong."]);
    }

    return database.transaction(() => {
      const current = read();
      const teamExists = current.state.teams.some((team) => team.id === teamId);
      if (!current.state.rebuttalOpen || current.state.buzzerTeamId || !teamExists) {
        return { accepted: false, ...current };
      }

      const next = { ...current.state, buzzerTeamId: teamId, updatedAt: Date.now() };
      const revision = current.revision + 1;
      updateRow.run(revision, JSON.stringify(next), next.updatedAt);
      return { accepted: true, revision, state: next };
    }).immediate();
  }

  return {
    read,
    replace,
    claimBuzzer,
    close() {
      database.close();
    },
  };
}
