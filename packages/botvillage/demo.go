package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

func createDemoStore() (*Store, string, error) {
	dir, err := os.MkdirTemp("", "botvillage-demo-*")
	if err != nil {
		return nil, "", err
	}
	path := filepath.Join(dir, "invoker.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, "", err
	}
	schema := `
CREATE TABLE worker_desired_states (
  worker_kind TEXT PRIMARY KEY,
  desired_enabled INTEGER NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE worker_actions (
  id TEXT PRIMARY KEY,
  worker_kind TEXT NOT NULL,
  action_type TEXT NOT NULL,
  workflow_id TEXT,
  task_id TEXT,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  external_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  intent_id TEXT,
  agent_name TEXT,
  execution_model TEXT,
  session_id TEXT,
  summary TEXT,
  payload_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(worker_kind, external_key)
);
`
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		_ = os.RemoveAll(dir)
		return nil, "", err
	}

	kinds := []string{
		"reaper", "autofix", "disk-headroom", "pr-status", "ci-failure",
		"pr-ci-failure-scan", "e2e-autofix", "auto-approve", "requeue",
		"idle-task-cleanup", "cross-repo-research", "catstack-deploy",
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, kind := range kinds {
		if _, err := db.Exec(
			`INSERT INTO worker_desired_states(worker_kind, desired_enabled, updated_at) VALUES(?,?,?)`,
			kind, 1, now,
		); err != nil {
			_ = db.Close()
			_ = os.RemoveAll(dir)
			return nil, "", err
		}
	}

	reaperPayload, _ := json.Marshal(map[string]any{
		"orphanResults":   []map[string]any{{"name": "mac-mini", "ok": true}, {"name": "gpu-box", "ok": true}},
		"worktreeResults": []map[string]any{{"name": "mac-mini", "ok": true}},
	})
	insertAction := func(id, kind, actionType, subjectType, subjectID, status, payload string) error {
		_, err := db.Exec(`
INSERT INTO worker_actions(
  id, worker_kind, action_type, subject_type, subject_id, external_key, status,
  attempt_count, summary, payload_json, created_at, updated_at
) VALUES (?,?,?,?,?,?,?,1,?,?,?,?)`,
			id, kind, actionType, subjectType, subjectID, id, status,
			actionType+" on "+subjectID, payload, now, now,
		)
		return err
	}

	if err := insertAction("demo-reaper", "reaper", "reaper-pass", "invoker-home", dir, "running", string(reaperPayload)); err != nil {
		_ = db.Close()
		_ = os.RemoveAll(dir)
		return nil, "", err
	}
	for i, pr := range []string{"101", "102", "103"} {
		if err := insertAction(
			fmt.Sprintf("demo-autofix-%d", i), "autofix", "repair-ci", "pr", pr, "running", "",
		); err != nil {
			_ = db.Close()
			_ = os.RemoveAll(dir)
			return nil, "", err
		}
	}
	if err := insertAction("demo-disk", "disk-headroom", "scan", "remote", "gpu-box", "pending", ""); err != nil {
		_ = db.Close()
		_ = os.RemoveAll(dir)
		return nil, "", err
	}
	if err := insertAction("demo-ci", "ci-failure", "repair", "pr", "2200", "queued", ""); err != nil {
		_ = db.Close()
		_ = os.RemoveAll(dir)
		return nil, "", err
	}

	_ = db.Close()
	store, err := openReadOnlyStore(path)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, "", err
	}
	store.SetRemoteTargets([]string{"mac-mini", "gpu-box"})

	// Background demo churn: flip a completed autofix back to running occasionally via a writable sibling handle.
	go demoChurn(path)

	return store, dir, nil
}

func demoChurn(path string) {
	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()
	n := 0
	for range ticker.C {
		n++
		db, err := sql.Open("sqlite", path)
		if err != nil {
			continue
		}
		status := "running"
		if n%3 == 0 {
			status = "completed"
		}
		pr := fmt.Sprintf("%d", 300+n%5)
		id := fmt.Sprintf("demo-churn-%d", n%5)
		now := time.Now().UTC().Format(time.RFC3339Nano)
		_, _ = db.Exec(`
INSERT INTO worker_actions(
  id, worker_kind, action_type, subject_type, subject_id, external_key, status,
  attempt_count, summary, payload_json, created_at, updated_at
) VALUES (?,?,?,?,?,?,?,1,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET status=excluded.status, subject_id=excluded.subject_id, updated_at=excluded.updated_at
`, id, "autofix", "repair-ci", "pr", pr, id, status, "churn", "", now, now)
		_ = db.Close()
	}
}
