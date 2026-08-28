package main

import (
	"os"
	"testing"
	"time"
)

func TestBuildWorldAutofixIllusions(t *testing.T) {
	world := buildWorld([]WorkerRow{{
		Kind:      "autofix",
		Note:      "Autofix worker",
		Lifecycle: "running",
		RecentActions: []WorkerAction{
			{ID: "a1", WorkerKind: "autofix", ActionType: "repair-ci", SubjectType: "pr", SubjectID: "1", Status: "running", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)},
			{ID: "a2", WorkerKind: "autofix", ActionType: "repair-ci", SubjectType: "pr", SubjectID: "2", Status: "queued", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)},
			{ID: "a3", WorkerKind: "autofix", ActionType: "repair-ci", SubjectType: "pr", SubjectID: "3", Status: "completed", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)},
		},
	}}, BuildOptions{Now: time.Now()})
	if world.ActiveTripCount != 2 {
		t.Fatalf("active trips=%d want 2", world.ActiveTripCount)
	}
	if world.Heroes[0].Mood != "working" {
		t.Fatalf("mood=%s", world.Heroes[0].Mood)
	}
}

func TestReaperPayloadFanout(t *testing.T) {
	payload := `{"orphanResults":[{"name":"mac-mini"},{"name":"gpu-box"}]}`
	world := buildWorld([]WorkerRow{{
		Kind:      "reaper",
		Lifecycle: "running",
		RecentActions: []WorkerAction{{
			ID: "r1", WorkerKind: "reaper", ActionType: "reaper-pass",
			SubjectType: "invoker-home", SubjectID: "/tmp/home", Status: "running",
			PayloadJSON: payload, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		}},
	}}, BuildOptions{RemoteTargets: []string{"mac-mini", "gpu-box", "unused"}, Now: time.Now()})
	if world.ActiveTripCount != 2 {
		t.Fatalf("trips=%d want 2", world.ActiveTripCount)
	}
	for _, trip := range world.Trips {
		if trip.SourceLandmarkID != fountainLandmarkID {
			t.Fatalf("source=%s", trip.SourceLandmarkID)
		}
	}
}

func TestUnknownSubjectSkipped(t *testing.T) {
	world := buildWorld([]WorkerRow{{
		Kind:      "disk-headroom",
		Lifecycle: "running",
		RecentActions: []WorkerAction{
			{ID: "bad", WorkerKind: "disk-headroom", ActionType: "scan", SubjectType: "  ", SubjectID: "x", Status: "running"},
			{ID: "ok", WorkerKind: "disk-headroom", ActionType: "scan", SubjectType: "widget", SubjectID: "42", Status: "running", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)},
		},
	}}, BuildOptions{Now: time.Now()})
	if world.ActiveTripCount != 1 {
		t.Fatalf("trips=%d", world.ActiveTripCount)
	}
	if world.Trips[0].DestLandmarkID != "pad:widget:42" {
		t.Fatalf("dest=%s", world.Trips[0].DestLandmarkID)
	}
}

func TestSleepMood(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	world := buildWorld([]WorkerRow{{
		Kind:      "pr-status",
		Lifecycle: "running",
		RecentActions: []WorkerAction{{
			ID: "old", WorkerKind: "pr-status", ActionType: "poll",
			SubjectType: "workflow", SubjectID: "wf", Status: "completed",
			UpdatedAt: now.Add(-2 * time.Hour).Format(time.RFC3339Nano),
		}},
	}}, BuildOptions{Now: now})
	if world.Heroes[0].Mood != "sleep" {
		t.Fatalf("mood=%s", world.Heroes[0].Mood)
	}
}

func TestAvatarDeterminism(t *testing.T) {
	a := critterFace("reaper")
	b := critterFace("reaper")
	c := critterFace("autofix")
	if a.Bounds() != b.Bounds() {
		t.Fatal("bounds mismatch")
	}
	if a.At(16, 16) != b.At(16, 16) {
		t.Fatal("same id should match pixels")
	}
	if a.At(16, 16) == c.At(16, 16) {
		// possible but unlikely; check another pixel
		if a.At(11, 14) == c.At(11, 14) && a.At(20, 20) == c.At(20, 20) {
			t.Fatal("different ids unexpectedly identical")
		}
	}
}

func TestDemoStoreReadOnly(t *testing.T) {
	store, dir, err := createDemoStore()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = store.Close()
		_ = removeAll(dir)
	}()
	world, err := store.BuildWorld()
	if err != nil {
		t.Fatal(err)
	}
	if world.ActiveTripCount < 3 {
		t.Fatalf("demo trips=%d", world.ActiveTripCount)
	}
	// Attempting to write through the read-only handle must fail.
	_, err = store.db.Exec(`UPDATE worker_desired_states SET desired_enabled=0`)
	if err == nil {
		t.Fatal("expected read-only write failure")
	}
}

func TestCoalesceFingerprintChanges(t *testing.T) {
	store, dir, err := createDemoStore()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = store.Close()
		_ = removeAll(dir)
	}()
	fp1, err := store.SnapshotFingerprint()
	if err != nil {
		t.Fatal(err)
	}
	fp2, err := store.SnapshotFingerprint()
	if err != nil {
		t.Fatal(err)
	}
	if fp1 != fp2 {
		t.Fatal("stable fingerprint expected")
	}
}

func removeAll(dir string) error {
	return os.RemoveAll(dir)
}
