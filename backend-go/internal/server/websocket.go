package server

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = 25 * time.Second
	maxMessageSize = 16 * 1024
)

type Hub struct {
	mu      sync.Mutex
	clients map[*WSClient]bool
}

type WSClient struct {
	conn      *websocket.Conn
	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

func NewHub() *Hub {
	return &Hub{clients: make(map[*WSClient]bool)}
}

func websocketUpgrader(originAllowed func(string) bool) websocket.Upgrader {
	return websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			return origin == "" || originAllowed(origin)
		},
	}
}

func (h *Hub) Add(conn *websocket.Conn) *WSClient {
	client := &WSClient{conn: conn, send: make(chan []byte, 32), done: make(chan struct{})}
	h.mu.Lock()
	h.clients[client] = true
	h.mu.Unlock()
	return client
}

func (h *Hub) Remove(client *WSClient) {
	h.mu.Lock()
	delete(h.clients, client)
	h.mu.Unlock()
	client.closeOnce.Do(func() { close(client.done) })
}

func (c *WSClient) Send(message any) {
	payload, err := json.Marshal(message)
	if err != nil {
		_ = c.conn.Close()
		return
	}
	select {
	case c.send <- payload:
	default:
		_ = c.conn.Close()
	}
}

func (h *Hub) Broadcast(message any) {
	payload, err := json.Marshal(message)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for client := range h.clients {
		select {
		case client.send <- payload:
		default:
			_ = client.conn.Close()
			delete(h.clients, client)
		}
	}
}

func (c *WSClient) WriteLoop() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for {
		select {
		case message := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				_ = c.conn.Close()
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				_ = c.conn.Close()
				return
			}
		case <-c.done:
			return
		}
	}
}
