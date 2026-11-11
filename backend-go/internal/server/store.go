package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type Snapshot struct {
	Revision int64           `json:"revision"`
	State    json.RawMessage `json:"state"`
}

type Store struct {
	mu sync.Mutex
	db *sql.DB
}

func OpenStore(filename string) (*Store, error) {
	if filename != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(filename), 0755); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}
	db, err := sql.Open("sqlite3", filename)
	if err != nil {
		return nil, fmt.Errorf("open SQLite database: %w", err)
	}
	db.SetMaxOpenConns(1)
	for _, statement := range []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA foreign_keys = ON",
		"PRAGMA busy_timeout = 5000",
		`CREATE TABLE IF NOT EXISTS competition_state (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			revision INTEGER NOT NULL,
			state_json TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			return nil, fmt.Errorf("initialize SQLite database: %w", err)
		}
	}
	empty, _ := json.Marshal(emptyState())
	if _, err := db.Exec(
		"INSERT OR IGNORE INTO competition_state (singleton, revision, state_json, updated_at) VALUES (1, 0, ?, ?)",
		string(empty), time.Now().UnixMilli(),
	); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize competition state: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) Read() (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

func (s *Store) Replace(raw json.RawMessage, expectedRevision int64, startDelay time.Duration) (Snapshot, bool, error) {
	var next map[string]any
	if err := json.Unmarshal(raw, &next); err != nil || next == nil {
		return Snapshot{}, false, &ValidationError{Issues: []string{"State harus berupa objek JSON."}}
	}
	if issues := validateState(next); len(issues) > 0 {
		return Snapshot{}, false, &ValidationError{Issues: issues}
	}
	if expectedRevision < 0 {
		return Snapshot{}, false, &ValidationError{Issues: []string{"expectedRevision harus berupa bilangan bulat nol atau lebih."}}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.readLocked()
	if err != nil {
		return Snapshot{}, false, err
	}
	if current.Revision != expectedRevision {
		return current, false, &RevisionConflictError{Latest: current}
	}
	currentState := decodeState(current.State)
	next["buzzerTieTeamIds"] = []any{}
	roundStarted := false
	if !boolValue(next["rebuttalOpen"]) {
		next["buzzerOpensAt"] = nil
	} else if !boolValue(currentState["rebuttalOpen"]) ||
		currentState["buzzerTeamId"] != nil ||
		len(arrayValue(currentState["buzzerTieTeamIds"])) > 0 ||
		numberValue(currentState["buzzerOpensAt"]) <= 0 {
		next["buzzerOpensAt"] = time.Now().Add(startDelay).UnixMilli()
		next["buzzerTeamId"] = nil
		next["buzzerTieTeamIds"] = []any{}
		roundStarted = true
	} else {
		next["buzzerOpensAt"] = currentState["buzzerOpensAt"]
		next["buzzerTeamId"] = currentState["buzzerTeamId"]
		next["buzzerTieTeamIds"] = currentState["buzzerTieTeamIds"]
	}
	next["updatedAt"] = time.Now().UnixMilli()
	return s.writeLocked(next, current.Revision+1, roundStarted)
}

func (s *Store) ClaimBuzzer(teamID string) (Snapshot, bool, int64, error) {
	if teamID == "" || len(teamID) > 128 {
		return Snapshot{}, false, 0, &ValidationError{Issues: []string{"teamId harus berupa string yang tidak kosong."}}
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	current, err := s.readLocked()
	if err != nil {
		return Snapshot{}, false, 0, err
	}
	state := decodeState(current.State)
	now := time.Now().UnixMilli()
	if !boolValue(state["rebuttalOpen"]) || state["buzzerTeamId"] != nil ||
		len(arrayValue(state["buzzerTieTeamIds"])) > 0 ||
		!containsTeam(state["teams"], teamID) ||
		(numberValue(state["buzzerOpensAt"]) > 0 && now < int64(numberValue(state["buzzerOpensAt"]))) {
		return current, false, now, nil
	}

	state["buzzerTeamId"] = teamID
	state["buzzerTieTeamIds"] = []any{}
	state["updatedAt"] = now
	next, _, err := s.writeLocked(state, current.Revision+1, false)
	return next, err == nil, now, err
}

func (s *Store) readLocked() (Snapshot, error) {
	var snapshot Snapshot
	var raw string
	if err := s.db.QueryRow(
		"SELECT revision, state_json FROM competition_state WHERE singleton = 1",
	).Scan(&snapshot.Revision, &raw); err != nil {
		return Snapshot{}, fmt.Errorf("read competition state: %w", err)
	}
	state := decodeState(json.RawMessage(raw))
	if _, ok := state["buzzerTieTeamIds"]; !ok {
		state["buzzerTieTeamIds"] = []any{}
	}
	snapshot.State, _ = json.Marshal(state)
	return snapshot, nil
}

func (s *Store) writeLocked(state map[string]any, revision int64, roundStarted bool) (Snapshot, bool, error) {
	raw, err := json.Marshal(state)
	if err != nil {
		return Snapshot{}, false, fmt.Errorf("encode competition state: %w", err)
	}
	if _, err := s.db.Exec(
		"UPDATE competition_state SET revision = ?, state_json = ?, updated_at = ? WHERE singleton = 1",
		revision, string(raw), time.Now().UnixMilli(),
	); err != nil {
		return Snapshot{}, false, fmt.Errorf("write competition state: %w", err)
	}
	return Snapshot{Revision: revision, State: raw}, roundStarted, nil
}

func decodeState(raw json.RawMessage) map[string]any {
	state := make(map[string]any)
	_ = json.Unmarshal(raw, &state)
	return state
}

type RevisionConflictError struct {
	Latest Snapshot
}

func (e *RevisionConflictError) Error() string { return "State telah diperbarui oleh klien lain." }

type ValidationError struct {
	Issues []string
}

func (e *ValidationError) Error() string { return "State tidak valid." }
