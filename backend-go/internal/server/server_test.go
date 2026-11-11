package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestClaimBuzzerLocksFirstAcceptedTeam(t *testing.T) {
	store, err := OpenStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	snapshot := saveOpenRound(t, store, 0)
	if snapshot.Revision != 1 {
		t.Fatalf("round revision = %d, want 1", snapshot.Revision)
	}

	type result struct {
		teamID   string
		accepted bool
		err      error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	var wait sync.WaitGroup
	for _, teamID := range []string{"team-a", "team-b"} {
		wait.Add(1)
		go func(teamID string) {
			defer wait.Done()
			<-start
			_, accepted, _, claimErr := store.ClaimBuzzer(teamID)
			results <- result{teamID: teamID, accepted: accepted, err: claimErr}
		}(teamID)
	}
	close(start)
	wait.Wait()
	close(results)

	winners := 0
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.accepted {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("accepted claims = %d, want exactly one", winners)
	}
	final, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	state := decodeState(final.State)
	if state["buzzerTeamId"] != "team-a" && state["buzzerTeamId"] != "team-b" {
		t.Fatalf("persisted winner = %v, want one submitted team", state["buzzerTeamId"])
	}
	if final.Revision != 2 {
		t.Fatalf("final revision = %d, want one winner revision after opening", final.Revision)
	}
}

func TestWebSocketTimeSyncAndBuzzProtocol(t *testing.T) {
	service, err := New(Config{
		DatabasePath: ":memory:", FrontendPort: 5173, BuzzerStartDelay: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	saveOpenRound(t, service.store, 0)

	httpServer := httptest.NewServer(service)
	defer httpServer.Close()
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	var message map[string]any
	if err := conn.ReadJSON(&message); err != nil {
		t.Fatal(err)
	}
	if message["type"] != "STATE" {
		t.Fatalf("initial message type = %v, want STATE", message["type"])
	}

	if err := conn.WriteJSON(map[string]any{
		"type": "SYNC_TIME", "clientTime": 1710000000000, "requestId": "sync-test",
	}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	if err := conn.SetReadDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	for {
		if err := conn.ReadJSON(&message); err != nil {
			t.Fatal(err)
		}
		if message["type"] == "SYNC_ACK" {
			if message["requestId"] != "sync-test" || message["clientTime"] != float64(1710000000000) {
				t.Fatalf("unexpected sync acknowledgement: %#v", message)
			}
			if message["serverTime"] == nil {
				t.Fatal("SYNC_ACK omitted serverTime")
			}
			break
		}
	}

	if err := conn.WriteJSON(map[string]any{
		"type": "BUZZ", "requestId": "buzz-test", "clientId": "team-a",
		"clientTimestamp": 1710000005120,
	}); err != nil {
		t.Fatal(err)
	}
	var gotWinner, gotAck bool
	for !gotAck {
		if err := conn.ReadJSON(&message); err != nil {
			t.Fatal(err)
		}
		switch message["type"] {
		case "WINNER":
			gotWinner = message["winnerId"] == "team-a"
			if message["timestamp"] == nil {
				t.Fatal("WINNER omitted authoritative server timestamp")
			}
		case "BUZZ_ACK":
			gotAck = message["requestId"] == "buzz-test" && message["accepted"] == true
		}
	}
	if !gotWinner {
		t.Fatal("server did not broadcast the accepted winner")
	}
}

func TestRESTRevisionConflictAndBuzzerCompatibility(t *testing.T) {
	service, err := New(Config{
		DatabasePath: ":memory:", FrontendPort: 5173, BuzzerStartDelay: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	httpServer := httptest.NewServer(service)
	defer httpServer.Close()

	state := map[string]any{
		"version": 1,
		"teams": []any{
			map[string]any{"id": "team-a", "name": "Tim A", "score": 0, "soundData": ""},
		},
		"questions": []any{}, "currentQuestionId": nil, "rebuttalOpen": true,
		"screen": "question", "updatedAt": time.Now().UnixMilli(),
	}
	body, _ := json.Marshal(map[string]any{"state": state, "expectedRevision": 0})
	request, err := http.NewRequest(http.MethodPut, httpServer.URL+"/api/state", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("PUT /api/state status = %d, want 200", response.StatusCode)
	}

	response, err = http.Post(httpServer.URL+"/api/buzzer", "application/json", strings.NewReader(`{"teamId":"team-a"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result map[string]any
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || result["accepted"] != true {
		t.Fatalf("legacy HTTP buzzer claim result = %#v, status %d", result, response.StatusCode)
	}

	request, err = http.NewRequest(http.MethodPut, httpServer.URL+"/api/state", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("stale PUT /api/state status = %d, want 409", response.StatusCode)
	}
}

func TestReadsAndUpdatesLegacySQLiteState(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "legacy.sqlite")
	db, err := sql.Open("sqlite3", filename)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE competition_state (
		singleton INTEGER PRIMARY KEY,
		revision INTEGER NOT NULL,
		state_json TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)`)
	if err != nil {
		t.Fatal(err)
	}
	legacyState := `{"version":1,"teams":[{"id":"legacy-team","name":"Legacy","score":0,"soundData":""}],"questions":[],"currentQuestionId":null,"rebuttalOpen":true,"buzzerOpensAt":1,"buzzerTeamId":null,"screen":"question","updatedAt":1}`
	if _, err := db.Exec(
		"INSERT INTO competition_state (singleton, revision, state_json, updated_at) VALUES (1, 7, ?, 1)",
		legacyState,
	); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := OpenStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	snapshot, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Revision != 7 || decodeState(snapshot.State)["teams"] == nil {
		t.Fatalf("legacy snapshot = %#v, want revision 7 and teams", snapshot)
	}
	updated, accepted, _, err := store.ClaimBuzzer("legacy-team")
	if err != nil {
		t.Fatal(err)
	}
	if !accepted || updated.Revision != 8 || decodeState(updated.State)["buzzerTeamId"] != "legacy-team" {
		t.Fatalf("legacy database claim = %#v, accepted %v", updated, accepted)
	}
}

func TestCORSAllowsIPv6LoopbackOrigin(t *testing.T) {
	service, err := New(Config{
		DatabasePath: ":memory:", FrontendPort: 5173, BuzzerStartDelay: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	request := httptest.NewRequest(http.MethodOptions, "/api/state", nil)
	request.Header.Set("Origin", "http://[::1]:5173")
	response := httptest.NewRecorder()
	service.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("IPv6 CORS preflight status = %d, want 204", response.Code)
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "http://[::1]:5173" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want IPv6 origin", got)
	}
}

func saveOpenRound(t *testing.T, store *Store, expected int64) Snapshot {
	t.Helper()
	state := map[string]any{
		"version": 1,
		"teams": []any{
			map[string]any{"id": "team-a", "name": "Tim A", "score": 0, "soundData": ""},
			map[string]any{"id": "team-b", "name": "Tim B", "score": 0, "soundData": ""},
		},
		"questions": []any{}, "currentQuestionId": nil, "rebuttalOpen": true,
		"screen": "question", "updatedAt": time.Now().UnixMilli(),
	}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, _, err := store.Replace(raw, expected, 0)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}
