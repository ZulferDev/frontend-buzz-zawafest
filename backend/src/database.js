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
    const state = JSON.parse(row.state_json);
    state.buzzerTieTeamIds ??= [];
    return { revision: row.revision, state };
  }

  function replace(state, expectedRevision, buzzerStartDelayMs = 0) {
    const issues = validateState(state);
    if (issues.length) throw new StateValidationError(issues);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new StateValidationError(["expectedRevision harus berupa bilangan bulat nol atau lebih."]);
    }
    if (!Number.isSafeInteger(buzzerStartDelayMs) || buzzerStartDelayMs < 0) {
      throw new StateValidationError(["buzzerStartDelayMs harus berupa bilangan bulat nol atau lebih."]);
    }

    return database.transaction(() => {
      const current = read();
      if (current.revision !== expectedRevision) throw new RevisionConflictError(current);

      const next = structuredClone(state);
      next.buzzerTieTeamIds ??= current.state.buzzerTieTeamIds;
      if (!next.rebuttalOpen) {
        next.buzzerOpensAt = null;
      } else if (
        !current.state.rebuttalOpen
        || current.state.buzzerTeamId !== null
        || current.state.buzzerTieTeamIds.length > 0
        || !Number.isFinite(current.state.buzzerOpensAt)
      ) {
        next.buzzerOpensAt = Date.now() + buzzerStartDelayMs;
        next.buzzerTeamId = null;
        next.buzzerTieTeamIds = [];
      } else {
        next.buzzerOpensAt = current.state.buzzerOpensAt;
        next.buzzerTeamId = current.state.buzzerTeamId;
        next.buzzerTieTeamIds = current.state.buzzerTieTeamIds;
      }
      next.updatedAt = Date.now();
      const revision = current.revision + 1;
      updateRow.run(revision, JSON.stringify(next), next.updatedAt);
      return { revision, state: next };
    }).immediate();
  }

  function claimBuzzer(teamIds) {
    if (!Array.isArray(teamIds) || teamIds.length === 0
      || teamIds.some((teamId) => typeof teamId !== "string" || !teamId.trim() || teamId.length > 128)) {
      throw new StateValidationError(["teamIds harus berisi ID tim yang valid."]);
    }

    return database.transaction(() => {
      const current = read();
      const uniqueTeamIds = [...new Set(teamIds)];
      const knownTeamIds = new Set(current.state.teams.map((team) => team.id));
      const acceptedTeamIds = uniqueTeamIds.filter((teamId) => knownTeamIds.has(teamId));
      if (
        !current.state.rebuttalOpen
        || current.state.buzzerTeamId
        || current.state.buzzerTieTeamIds.length > 0
        || acceptedTeamIds.length === 0
        || (Number.isFinite(current.state.buzzerOpensAt) && Date.now() < current.state.buzzerOpensAt)
      ) {
        return { acceptedTeamIds: [], ...current };
      }

      const next = {
        ...current.state,
        buzzerTeamId: acceptedTeamIds.length === 1 ? acceptedTeamIds[0] : null,
        buzzerTieTeamIds: acceptedTeamIds.length > 1 ? acceptedTeamIds : [],
        updatedAt: Date.now(),
      };
      const revision = current.revision + 1;
      updateRow.run(revision, JSON.stringify(next), next.updatedAt);
      return { acceptedTeamIds, revision, state: next };
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
