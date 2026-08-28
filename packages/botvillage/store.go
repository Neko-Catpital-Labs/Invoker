package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db            *sql.DB
	path          string
	remoteTargets []string
}

func openReadOnlyStore(path string) (*Store, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(abs); err != nil {
		return nil, err
	}
	// mode=ro + immutable query params keep the handle read-only.
	dsn := fmt.Sprintf("file:%s?mode=ro&_pragma=query_only(1)", filepath.ToSlash(abs))
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db, path: abs}, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) SetRemoteTargets(names []string) {
	s.remoteTargets = append([]string(nil), names...)
}

func (s *Store) RemoteTargets() []string {
	return append([]string(nil), s.remoteTargets...)
}

func (s *Store) LoadWorkers() ([]WorkerRow, error) {
	kinds := map[string]*WorkerRow{}

	desiredRows, err := s.db.Query(`SELECT worker_kind, desired_enabled FROM worker_desired_states`)
	if err == nil {
		defer desiredRows.Close()
		for desiredRows.Next() {
			var kind string
			var enabled int
			if err := desiredRows.Scan(&kind, &enabled); err != nil {
				return nil, err
			}
			lifecycle := "stopped"
			if enabled != 0 {
				lifecycle = "running"
			}
			kinds[kind] = &WorkerRow{
				Kind:           kind,
				Note:           displayName(kind) + " worker",
				Lifecycle:      lifecycle,
				DesiredEnabled: enabled != 0,
			}
		}
	}

	actionRows, err := s.db.Query(`
		SELECT id, worker_kind, action_type, subject_type, subject_id, status,
		       COALESCE(summary, ''), COALESCE(payload_json, ''),
		       created_at, updated_at, COALESCE(completed_at, '')
		FROM worker_actions
		ORDER BY updated_at DESC, id DESC
		LIMIT 500
	`)
	if err != nil {
		return nil, err
	}
	defer actionRows.Close()

	perKind := map[string][]WorkerAction{}
	for actionRows.Next() {
		var a WorkerAction
		if err := actionRows.Scan(
			&a.ID, &a.WorkerKind, &a.ActionType, &a.SubjectType, &a.SubjectID, &a.Status,
			&a.Summary, &a.PayloadJSON, &a.CreatedAt, &a.UpdatedAt, &a.CompletedAt,
		); err != nil {
			return nil, err
		}
		if _, ok := kinds[a.WorkerKind]; !ok {
			kinds[a.WorkerKind] = &WorkerRow{
				Kind:      a.WorkerKind,
				Note:      displayName(a.WorkerKind) + " worker",
				Lifecycle: "running",
			}
		}
		list := perKind[a.WorkerKind]
		if len(list) >= 20 {
			continue
		}
		perKind[a.WorkerKind] = append(list, a)
	}
	if err := actionRows.Err(); err != nil {
		return nil, err
	}

	out := make([]WorkerRow, 0, len(kinds))
	for kind, row := range kinds {
		row.RecentActions = perKind[kind]
		out = append(out, *row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Kind < out[j].Kind })
	return out, nil
}

func (s *Store) SnapshotFingerprint() (string, error) {
	workers, err := s.LoadWorkers()
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for _, w := range workers {
		b.WriteString(w.Kind)
		b.WriteByte('|')
		b.WriteString(w.Lifecycle)
		b.WriteByte('|')
		for _, a := range w.RecentActions {
			b.WriteString(a.ID)
			b.WriteByte(':')
			b.WriteString(a.Status)
			b.WriteByte(':')
			b.WriteString(a.UpdatedAt)
			b.WriteByte(';')
		}
		b.WriteByte('\n')
	}
	return b.String(), nil
}

func (s *Store) BuildWorld() (World, error) {
	workers, err := s.LoadWorkers()
	if err != nil {
		return World{}, err
	}
	return buildWorld(workers, BuildOptions{
		RemoteTargets: s.remoteTargets,
		Now:           time.Now(),
	}), nil
}
