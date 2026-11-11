package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabasePath     string
	FrontendPort     int
	AllowedOrigins   []string
	BuzzerStartDelay time.Duration
}

type Server struct {
	store            *Store
	hub              *Hub
	frontendPort     int
	allowedOrigins   map[string]bool
	buzzerStartDelay time.Duration
}

func New(config Config) (*Server, error) {
	if config.FrontendPort < 1 || config.FrontendPort > 65535 {
		return nil, fmt.Errorf("FRONTEND_PORT harus berupa bilangan bulat antara 1 dan 65535")
	}
	if config.BuzzerStartDelay < 0 || config.BuzzerStartDelay > 30*time.Second {
		return nil, fmt.Errorf("BUZZER_START_DELAY_MS harus antara 0 dan 30000")
	}
	store, err := OpenStore(config.DatabasePath)
	if err != nil {
		return nil, err
	}
	origins := make(map[string]bool, len(config.AllowedOrigins))
	for _, origin := range config.AllowedOrigins {
		origins[origin] = true
	}
	service := &Server{
		store:            store,
		hub:              NewHub(),
		frontendPort:     config.FrontendPort,
		allowedOrigins:   origins,
		buzzerStartDelay: config.BuzzerStartDelay,
	}
	return service, nil
}

func (s *Server) Close() error {
	return s.store.Close()
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/ws" {
		s.serveWebSocket(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		if !s.applyCORS(w, r) {
			return
		}
		w.Header().Set("X-Server-Time", strconv.FormatInt(time.Now().UnixMilli(), 10))
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}

	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/health":
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	case r.Method == http.MethodGet && r.URL.Path == "/api/state":
		s.getState(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/api/teams":
		s.getTeams(w)
	case r.Method == http.MethodGet && r.URL.Path == "/api/questions":
		s.getQuestions(w)
	case r.Method == http.MethodPut && r.URL.Path == "/api/state":
		s.replaceState(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/api/buzzer":
		s.claimHTTP(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "Endpoint tidak ditemukan."})
	}
}

func (s *Server) applyCORS(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin != "" && !s.originAllowed(origin) {
		return false
	}
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Add("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Expose-Headers", "X-Server-Time")
	w.Header().Set("Access-Control-Max-Age", "86400")
	return true
}

func (s *Server) originAllowed(origin string) bool {
	if s.allowedOrigins[origin] || s.allowedOrigins["*"] {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Port() != strconv.Itoa(s.frontendPort) || parsed.User != nil ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	hostname := strings.Trim(parsed.Hostname(), "[]")
	if hostname == "localhost" || strings.HasSuffix(hostname, ".localhost") {
		return true
	}
	ip := net.ParseIP(hostname)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() {
		return true
	}
	return false
}

func (s *Server) getState(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.store.Read()
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if raw, exists := r.URL.Query()["since"]; exists {
		if len(raw) != 1 || !validRevision(raw[0]) {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "invalid_revision", "message": "since harus berupa revision bilangan bulat nol atau lebih.",
			})
			return
		}
		since, _ := strconv.ParseInt(raw[0], 10, 64)
		if snapshot.Revision == since {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) getTeams(w http.ResponseWriter) {
	snapshot, err := s.store.Read()
	if err != nil {
		writeInternalError(w, err)
		return
	}
	state := decodeState(snapshot.State)
	writeJSON(w, http.StatusOK, map[string]any{"revision": snapshot.Revision, "teams": state["teams"]})
}

func (s *Server) getQuestions(w http.ResponseWriter) {
	snapshot, err := s.store.Read()
	if err != nil {
		writeInternalError(w, err)
		return
	}
	state := decodeState(snapshot.State)
	writeJSON(w, http.StatusOK, map[string]any{
		"revision": snapshot.Revision, "questions": state["questions"], "currentQuestionId": state["currentQuestionId"],
	})
}

func (s *Server) replaceState(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 5*1024*1024+64*1024)
	var body struct {
		State            json.RawMessage `json:"state"`
		ExpectedRevision *int64          `json:"expectedRevision"`
	}
	if err := decodeRequest(r, &body); err != nil || len(body.State) == 0 || body.ExpectedRevision == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json", "message": "Body harus memuat state dan expectedRevision."})
		return
	}
	snapshot, roundStarted, err := s.store.Replace(body.State, *body.ExpectedRevision, s.buzzerStartDelay)
	if err != nil {
		var conflict *RevisionConflictError
		if errors.As(err, &conflict) {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "revision_conflict", "message": err.Error(), "latest": conflict.Latest,
			})
			return
		}
		var validation *ValidationError
		if errors.As(err, &validation) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"error": "invalid_state", "message": err.Error(), "issues": validation.Issues,
			})
			return
		}
		writeInternalError(w, err)
		return
	}
	s.publishSnapshot(snapshot)
	if roundStarted {
		state := decodeState(snapshot.State)
		s.hub.Broadcast(map[string]any{"type": "ROUND_START", "roundId": state["currentQuestionId"]})
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) claimHTTP(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	var body struct {
		TeamID string `json:"teamId"`
	}
	if err := decodeRequest(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json", "message": "Body harus berupa objek JSON."})
		return
	}
	snapshot, accepted, timestamp, err := s.store.ClaimBuzzer(body.TeamID)
	if err != nil {
		var validation *ValidationError
		if errors.As(err, &validation) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"error": "invalid_request", "message": err.Error(), "issues": validation.Issues,
			})
			return
		}
		writeInternalError(w, err)
		return
	}
	if accepted {
		s.publishWinner(snapshot, body.TeamID, timestamp)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"revision": snapshot.Revision, "state": snapshot.State, "accepted": accepted,
	})
}

func (s *Server) publishSnapshot(snapshot Snapshot) {
	s.hub.Broadcast(map[string]any{"type": "STATE", "snapshot": snapshot})
}

func (s *Server) publishWinner(snapshot Snapshot, winnerID string, timestamp int64) {
	s.publishSnapshot(snapshot)
	s.hub.Broadcast(map[string]any{"type": "WINNER", "winnerId": winnerID, "timestamp": timestamp})
}

func (s *Server) serveWebSocket(w http.ResponseWriter, r *http.Request) {
	upgrader := websocketUpgrader(s.originAllowed)
	client, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	connection := s.hub.Add(client)
	defer func() {
		s.hub.Remove(connection)
		_ = client.Close()
	}()

	snapshot, err := s.store.Read()
	if err != nil {
		return
	}
	connection.Send(map[string]any{"type": "STATE", "snapshot": snapshot})

	go connection.WriteLoop()
	client.SetReadLimit(16 * 1024)
	_ = client.SetReadDeadline(time.Now().Add(pongWait))
	client.SetPongHandler(func(string) error {
		return client.SetReadDeadline(time.Now().Add(pongWait))
	})
	client.SetReadLimit(maxMessageSize)
	for {
		_, payload, err := client.ReadMessage()
		if err != nil {
			break
		}
		var message map[string]any
		if err := json.Unmarshal(payload, &message); err != nil {
			connection.Send(map[string]any{"type": "ERROR", "message": "Pesan harus berupa JSON."})
			continue
		}
		s.handleWebSocketMessage(connection, message)
	}
}

func (s *Server) handleWebSocketMessage(client *WSClient, message map[string]any) {
	switch message["type"] {
	case "SYNC_TIME":
		clientTime, ok := message["clientTime"].(float64)
		if !ok || !finite(clientTime) {
			client.Send(map[string]any{"type": "ERROR", "message": "clientTime harus berupa timestamp."})
			return
		}
		now := time.Now().UnixMilli()
		client.Send(map[string]any{
			"type": "SYNC_ACK", "serverTime": now, "clientTime": int64(clientTime),
			"requestId": message["requestId"],
		})
	case "BUZZ":
		clientID, ok := message["clientId"].(string)
		if !ok || strings.TrimSpace(clientID) == "" || len(clientID) > 128 {
			client.Send(map[string]any{"type": "ERROR", "message": "clientId harus berupa ID tim yang valid."})
			return
		}
		if timestamp, exists := message["clientTimestamp"]; exists && !finite(timestamp) {
			client.Send(map[string]any{"type": "ERROR", "message": "clientTimestamp harus berupa timestamp."})
			return
		}
		snapshot, accepted, timestamp, err := s.store.ClaimBuzzer(clientID)
		if err != nil {
			client.Send(map[string]any{"type": "ERROR", "message": err.Error()})
			return
		}
		if accepted {
			s.publishWinner(snapshot, clientID, timestamp)
		}
		client.Send(map[string]any{
			"type": "BUZZ_ACK", "requestId": message["requestId"], "accepted": accepted,
			"winnerId": decodeState(snapshot.State)["buzzerTeamId"], "timestamp": timestamp, "snapshot": snapshot,
		})
	default:
		client.Send(map[string]any{"type": "ERROR", "message": "Tipe pesan tidak dikenali."})
	}
}

func decodeRequest(r *http.Request, destination any) error {
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("request body must contain one JSON value")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if value != nil {
		_ = json.NewEncoder(w).Encode(value)
	}
}

func writeInternalError(w http.ResponseWriter, err error) {
	fmt.Printf("[api] Unhandled request error: %v\n", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{
		"error": "internal_error", "message": "Terjadi kesalahan pada server.",
	})
}

func validRevision(value string) bool {
	if value == "" || (len(value) > 1 && value[0] == '0') {
		return false
	}
	number, err := strconv.ParseInt(value, 10, 64)
	return err == nil && number >= 0
}
