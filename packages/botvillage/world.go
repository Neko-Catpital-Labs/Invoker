package main

import (
	"encoding/json"
	"strings"
	"time"
)

const (
	fountainLandmarkID = "landmark:fountain"
	sleepAfterDefault  = 15 * time.Minute
)

var activeStatuses = map[string]bool{
	"queued":        true,
	"pending":       true,
	"running":       true,
	"needs_input":   true,
	"review_ready":  true,
}

type Landmark struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Label string `json:"label"`
}

type Trip struct {
	ID                string `json:"id"`
	WorkerKind        string `json:"workerKind"`
	ActionID          string `json:"actionId"`
	ActionType        string `json:"actionType"`
	Status            string `json:"status"`
	SourceLandmarkID  string `json:"sourceLandmarkId"`
	DestLandmarkID    string `json:"destLandmarkId"`
	GoalWord          string `json:"goalWord"`
}

type Hero struct {
	WorkerKind         string `json:"workerKind"`
	Name               string `json:"name"`
	Title              string `json:"title"`
	Lifecycle          string `json:"lifecycle"`
	Mood               string `json:"mood"`
	TripCount          int    `json:"tripCount"`
	GoalWord           string `json:"goalWord"`
	StatusChip         string `json:"statusChip"`
	BarracksLandmarkID string `json:"barracksLandmarkId"`
}

type World struct {
	Heroes          []Hero     `json:"heroes"`
	Landmarks       []Landmark `json:"landmarks"`
	Trips           []Trip     `json:"trips"`
	ActiveTripCount int        `json:"activeTripCount"`
	GeneratedAt     string     `json:"generatedAt"`
}

type WorkerAction struct {
	ID          string
	WorkerKind  string
	ActionType  string
	SubjectType string
	SubjectID   string
	Status      string
	Summary     string
	PayloadJSON string
	CreatedAt   string
	UpdatedAt   string
	CompletedAt string
}

type WorkerRow struct {
	Kind          string
	Note          string
	Lifecycle     string
	DesiredEnabled bool
	RecentActions []WorkerAction
}

type BuildOptions struct {
	RemoteTargets []string
	Now           time.Time
	SleepAfter    time.Duration
}

func barracksID(kind string) string { return "barracks:" + kind }

func formatWorkerValue(value string) string {
	parts := strings.FieldsFunc(value, func(r rune) bool {
		return r == '-' || r == '_'
	})
	for i, p := range parts {
		if p == "" {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	if len(parts) == 0 {
		return "Unknown"
	}
	return strings.Join(parts, " ")
}

func goalWord(actionType string) string {
	parts := strings.FieldsFunc(actionType, func(r rune) bool {
		return r == '-' || r == '_' || r == '/'
	})
	if len(parts) == 0 {
		return actionType
	}
	w := parts[0]
	if len(w) > 12 {
		w = w[:12]
	}
	return w
}

func displayName(kind string) string {
	switch kind {
	case "autofix":
		return "Autofix"
	case "pr-status":
		return "PR status"
	case "reaper":
		return "Reaper"
	case "disk-headroom":
		return "Disk headroom"
	default:
		return formatWorkerValue(kind)
	}
}

func ensureLandmark(m map[string]Landmark, id, kind, label string) {
	if _, ok := m[id]; ok {
		return
	}
	m[id] = Landmark{ID: id, Kind: kind, Label: label}
}

func classifySubject(subjectType, subjectID string, remotes map[string]bool) (kind, label, id string, ok bool) {
	t := strings.ToLower(strings.TrimSpace(subjectType))
	sid := strings.TrimSpace(subjectID)
	if t == "" || sid == "" {
		return "", "", "", false
	}
	switch {
	case t == "invoker-home" || t == "local" || (t == "host" && sid == "local"):
		return "fountain", "Fountain", fountainLandmarkID, true
	case t == "remote" || t == "remote-host" || t == "ssh" || t == "host" || remotes[sid]:
		return "outpost", sid, "outpost:" + sid, true
	case t == "pr" || t == "pull_request" || t == "github-pr" || strings.HasPrefix(t, "pr"):
		return "shop", "PR " + sid, "shop:pr:" + sid, true
	case t == "workflow" || t == "workflow-id":
		label := sid
		if len(label) > 16 {
			label = label[:16]
		}
		return "jungle", label, "jungle:" + sid, true
	case t == "task":
		label := sid
		if len(label) > 16 {
			label = label[:16]
		}
		return "pad", label, "pad:task:" + sid, true
	default:
		label := formatWorkerValue(t) + " " + sid
		if len(label) > 24 {
			label = label[:24]
		}
		return "pad", label, "pad:" + t + ":" + sid, true
	}
}

func remoteNamesFromPayloadJSON(payloadJSON string) []string {
	if strings.TrimSpace(payloadJSON) == "" {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	add := func(name string) {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		out = append(out, name)
	}
	collect := func(key string) {
		arr, ok := payload[key].([]any)
		if !ok {
			return
		}
		for _, entry := range arr {
			row, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			for _, k := range []string{"name", "target", "host"} {
				if s, ok := row[k].(string); ok {
					add(s)
					break
				}
			}
		}
	}
	collect("orphanResults")
	collect("worktreeResults")
	collect("remoteResults")
	collect("targets")
	if arr, ok := payload["remoteTargets"].([]any); ok {
		for _, entry := range arr {
			switch v := entry.(type) {
			case string:
				add(v)
			case map[string]any:
				if s, ok := v["name"].(string); ok {
					add(s)
				}
			}
		}
	}
	return out
}

func lastActivity(actions []WorkerAction) time.Time {
	var latest time.Time
	for _, a := range actions {
		stamp := a.UpdatedAt
		if stamp == "" {
			stamp = a.CreatedAt
		}
		t, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			t, err = time.Parse(time.RFC3339, stamp)
		}
		if err != nil {
			continue
		}
		if t.After(latest) {
			latest = t
		}
	}
	return latest
}

func heroMood(lifecycle string, tripCount int, actions []WorkerAction, now time.Time, sleepAfter time.Duration) string {
	if tripCount > 0 {
		return "working"
	}
	if lifecycle != "running" {
		return "idle"
	}
	last := lastActivity(actions)
	if last.IsZero() || now.Sub(last) >= sleepAfter {
		return "sleep"
	}
	return "idle"
}

func buildWorld(workers []WorkerRow, opts BuildOptions) World {
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	sleepAfter := opts.SleepAfter
	if sleepAfter <= 0 {
		sleepAfter = sleepAfterDefault
	}
	remotes := map[string]bool{}
	for _, n := range opts.RemoteTargets {
		n = strings.TrimSpace(n)
		if n != "" {
			remotes[n] = true
		}
	}
	landmarks := map[string]Landmark{}
	ensureLandmark(landmarks, fountainLandmarkID, "fountain", "Fountain")
	var trips []Trip
	var heroes []Hero

	for _, worker := range workers {
		home := barracksID(worker.Kind)
		ensureLandmark(landmarks, home, "barracks", displayName(worker.Kind))
		var workerTrips []Trip
		for _, action := range worker.RecentActions {
			if !activeStatuses[action.Status] {
				continue
			}
			t := strings.ToLower(strings.TrimSpace(action.SubjectType))
			isReaperFanout := (worker.Kind == "reaper" || strings.Contains(action.ActionType, "reaper")) &&
				(t == "invoker-home" || t == "local")
			if isReaperFanout {
				names := remoteNamesFromPayloadJSON(action.PayloadJSON)
				if len(names) == 0 {
					for n := range remotes {
						names = append(names, n)
					}
				}
				if len(names) == 0 {
					ensureLandmark(landmarks, fountainLandmarkID, "fountain", "Fountain")
					workerTrips = append(workerTrips, Trip{
						ID: action.ID + ":fountain", WorkerKind: worker.Kind, ActionID: action.ID,
						ActionType: action.ActionType, Status: action.Status,
						SourceLandmarkID: home, DestLandmarkID: fountainLandmarkID, GoalWord: goalWord(action.ActionType),
					})
					continue
				}
				for _, name := range names {
					kind, label, id, ok := classifySubject("remote", name, remotes)
					if !ok {
						continue
					}
					ensureLandmark(landmarks, fountainLandmarkID, "fountain", "Fountain")
					ensureLandmark(landmarks, id, kind, label)
					workerTrips = append(workerTrips, Trip{
						ID: action.ID + ":" + name, WorkerKind: worker.Kind, ActionID: action.ID,
						ActionType: action.ActionType, Status: action.Status,
						SourceLandmarkID: fountainLandmarkID, DestLandmarkID: id, GoalWord: goalWord(action.ActionType),
					})
				}
				continue
			}
			kind, label, id, ok := classifySubject(action.SubjectType, action.SubjectID, remotes)
			if !ok {
				continue
			}
			ensureLandmark(landmarks, id, kind, label)
			src := home
			if kind == "outpost" {
				src = fountainLandmarkID
				ensureLandmark(landmarks, fountainLandmarkID, "fountain", "Fountain")
			}
			workerTrips = append(workerTrips, Trip{
				ID: action.ID + ":0", WorkerKind: worker.Kind, ActionID: action.ID,
				ActionType: action.ActionType, Status: action.Status,
				SourceLandmarkID: src, DestLandmarkID: id, GoalWord: goalWord(action.ActionType),
			})
		}
		trips = append(trips, workerTrips...)
		mood := heroMood(worker.Lifecycle, len(workerTrips), worker.RecentActions, now, sleepAfter)
		goal := "idle"
		chip := mood
		if mood == "sleep" {
			goal = "zzz"
			chip = "sleep"
		} else if len(workerTrips) > 0 {
			goal = workerTrips[0].GoalWord
			chip = workerTrips[0].Status
		} else if worker.Lifecycle == "running" {
			chip = "idle"
		} else {
			chip = worker.Lifecycle
		}
		title := strings.TrimSpace(worker.Note)
		if title == "" {
			title = displayName(worker.Kind)
		}
		if len(title) > 48 {
			title = title[:48]
		}
		heroes = append(heroes, Hero{
			WorkerKind: worker.Kind, Name: displayName(worker.Kind), Title: title,
			Lifecycle: worker.Lifecycle, Mood: mood, TripCount: len(workerTrips),
			GoalWord: goal, StatusChip: chip, BarracksLandmarkID: home,
		})
	}
	for n := range remotes {
		ensureLandmark(landmarks, "outpost:"+n, "outpost", n)
	}
	outMarks := make([]Landmark, 0, len(landmarks))
	for _, l := range landmarks {
		outMarks = append(outMarks, l)
	}
	return World{
		Heroes: heroes, Landmarks: outMarks, Trips: trips,
		ActiveTripCount: len(trips), GeneratedAt: now.UTC().Format(time.RFC3339Nano),
	}
}
