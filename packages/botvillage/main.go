package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
)

//go:embed static/*
var staticFS embed.FS

func main() {
	listen := flag.String("listen", ":8040", "listen address")
	demo := flag.Bool("demo", false, "run with synthetic workers in a temp DB")
	data := flag.String("data", "", "path to invoker.db (default: $INVOKER_DB or ~/.invoker/invoker.db)")
	remotes := flag.String("remotes", "", "comma-separated remote target names")
	flag.Parse()

	var store *Store
	var cleanup func()
	if *demo {
		s, dir, err := createDemoStore()
		if err != nil {
			log.Fatalf("demo store: %v", err)
		}
		store = s
		cleanup = func() {
			_ = store.Close()
			_ = os.RemoveAll(dir)
		}
		log.Printf("demo DB at %s", filepath.Join(dir, "invoker.db"))
	} else {
		dbPath := strings.TrimSpace(*data)
		if dbPath == "" {
			dbPath = strings.TrimSpace(os.Getenv("INVOKER_DB"))
		}
		if dbPath == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				log.Fatalf("home: %v", err)
			}
			dbPath = filepath.Join(home, ".invoker", "invoker.db")
		}
		s, err := openReadOnlyStore(dbPath)
		if err != nil {
			log.Fatalf("open db %s: %v", dbPath, err)
		}
		store = s
		cleanup = func() { _ = store.Close() }
		log.Printf("watching %s (read-only)", dbPath)
	}
	defer cleanup()

	if *remotes != "" {
		parts := strings.Split(*remotes, ",")
		names := make([]string, 0, len(parts))
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p != "" {
				names = append(names, p)
			}
		}
		store.SetRemoteTargets(names)
	}

	hub := newHub(store)
	stop := make(chan struct{})
	go hub.pollLoop(stop)

	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("static: %v", err)
	}
	fileServer := http.FileServer(http.FS(sub))

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", hub.handleWS)
	mux.HandleFunc("/api/bots", func(w http.ResponseWriter, r *http.Request) {
		world, err := store.BuildWorld()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		bots := make([]map[string]any, 0, len(world.Heroes))
		for _, h := range world.Heroes {
			bots = append(bots, map[string]any{
				"id":     h.WorkerKind,
				"name":   h.Name,
				"title":  h.Title,
				"mood":   h.Mood,
				"status": h.StatusChip,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"bots": bots, "world": world})
	})
	mux.HandleFunc("/avatars/", handleAvatar)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			data, err := fs.ReadFile(sub, "index.html")
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(data)
			return
		}
		fileServer.ServeHTTP(w, r)
	})

	addr := *listen
	if !strings.Contains(addr, ":") {
		addr = ":" + addr
	}
	// Bind all interfaces so Tailscale peers can reach the island.
	if strings.HasPrefix(addr, ":") {
		addr = "0.0.0.0" + addr
	}

	server := &http.Server{Addr: addr, Handler: mux}
	go func() {
		log.Printf("botvillage listening on http://%s", addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	close(stop)
	_ = server.Close()
	fmt.Println("bye")
}
