package main

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const coalesceWindow = 250 * time.Millisecond

type Hub struct {
	mu      sync.Mutex
	clients map[*websocket.Conn]struct{}
	store   *Store
	lastFP  string
	upgrader websocket.Upgrader
}

func newHub(store *Store) *Hub {
	return &Hub{
		clients: make(map[*websocket.Conn]struct{}),
		store:   store,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

func (h *Hub) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	h.mu.Lock()
	h.clients[conn] = struct{}{}
	h.mu.Unlock()

	world, err := h.store.BuildWorld()
	if err == nil {
		_ = conn.WriteJSON(map[string]any{"type": "world", "world": world, "ts": time.Now().UTC().Format(time.RFC3339Nano)})
	}

	go func() {
		defer func() {
			h.mu.Lock()
			delete(h.clients, conn)
			h.mu.Unlock()
			_ = conn.Close()
		}()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
}

func (h *Hub) broadcast(world World) {
	msg, err := json.Marshal(map[string]any{
		"type":  "activity",
		"world": world,
		"ts":    time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for conn := range h.clients {
		if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			_ = conn.Close()
			delete(h.clients, conn)
		}
	}
}

func (h *Hub) pollLoop(stop <-chan struct{}) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	var pending bool
	var coalesce <-chan time.Time

	emit := func() {
		fp, err := h.store.SnapshotFingerprint()
		if err != nil {
			return
		}
		if fp == h.lastFP {
			return
		}
		h.lastFP = fp
		world, err := h.store.BuildWorld()
		if err != nil {
			return
		}
		h.broadcast(world)
	}

	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			fp, err := h.store.SnapshotFingerprint()
			if err != nil {
				continue
			}
			if fp == h.lastFP {
				continue
			}
			if !pending {
				pending = true
				coalesce = time.After(coalesceWindow)
			}
		case <-coalesce:
			pending = false
			coalesce = nil
			emit()
		}
	}
}
