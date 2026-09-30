package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

var wantLogRotation = []string{"--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=5"}

func containsSeq(args, seq []string) bool {
	for i := 0; i+len(seq) <= len(args); i++ {
		if reflect.DeepEqual(args[i:i+len(seq)], seq) {
			return true
		}
	}
	return false
}

// Regression for #45 (finding #408): containers the bridge starts with
// `docker run` must cap their json-file logs like the compose services do
// (x-logging: 10m x 5), or a months-long `-log` game server fills the disk.
func TestDockerRunCapsContainerLogs(t *testing.T) {
	f := &Fake{Stdout: []byte("id\n")}
	d := NewDocker(f)
	_, err := d.Run(context.Background(), ContainerRunSpec{
		ServerID:    "019dbb45-3556-751f-9124-d4cf0e6b0053",
		Image:       "squad-server:latest",
		GamePort:    7788,
		QueryPort:   27166,
		BeaconPort:  15001,
		RCONPort:    21115,
		ConfigsHost: "/var/lib/squad-panel/configs/019dbb45-3556-751f-9124-d4cf0e6b0053/ServerConfig",
		SavedHost:   "/var/lib/squad-panel/saved/019dbb45-3556-751f-9124-d4cf0e6b0053",
		DepotVolume: "squad-depot",
	})
	if err != nil {
		t.Fatal(err)
	}
	args := f.Calls[0].Args
	if !containsSeq(args, wantLogRotation) {
		t.Fatalf("squad server run args lack log rotation %v: %v", wantLogRotation, args)
	}
	if imageIdx := indexOf(args, "squad-server:latest"); imageIdx < 0 || indexOf(args, "--log-driver") > imageIdx {
		t.Fatalf("log flags must precede the image (docker options, not game args): %v", args)
	}
}

func TestComposeRNSquadJSArgsCapsContainerLogs(t *testing.T) {
	args, err := (&DockerRunner{}).composeRNSquadJSArgs(RNSquadJSRunSpec{ServerID: "0196f0a2-1111-2222-3333-444444444444"})
	if err != nil {
		t.Fatal(err)
	}
	if !containsSeq(args, wantLogRotation) {
		t.Fatalf("sidecar run args lack log rotation %v: %v", wantLogRotation, args)
	}
}

// Regression for #45 (finding #407): the sidecar container carries
// panel.preserve=true so `docker system prune --filter label!=panel.preserve=true`
// spares it (and therefore its image) while it is stopped.
func TestComposeRNSquadJSArgsPreservesSidecarFromPrune(t *testing.T) {
	args, err := (&DockerRunner{}).composeRNSquadJSArgs(RNSquadJSRunSpec{ServerID: "0196f0a2-1111-2222-3333-444444444444"})
	if err != nil {
		t.Fatal(err)
	}
	if !containsSeq(args, []string{"--label", "panel.preserve=true"}) {
		t.Fatalf("sidecar run args lack --label panel.preserve=true: %v", args)
	}
}

func indexOf(args []string, s string) int {
	for i, a := range args {
		if a == s {
			return i
		}
	}
	return -1
}

// Regression for #45 (finding #409): `docker logs --follow` without --tail
// replays the container's whole log history. tail<=0 means "no backfill"
// and oversized requests are clamped.
func TestLogsFollowAlwaysBoundsBackfill(t *testing.T) {
	cases := []struct {
		tail int
		want string
	}{
		{0, "0"},
		{-5, "0"},
		{200, "200"},
		{LogsFollowMaxTail, "5000"},
		{LogsFollowMaxTail + 1, "5000"},
		{1 << 30, "5000"},
	}
	for _, c := range cases {
		f := &Fake{}
		d := NewDocker(f)
		if _, err := d.LogsFollow(context.Background(), "squad-019dbb45-3556-751f-9124-d4cf0e6b0053", c.tail, nil, nil); err != nil {
			t.Fatal(err)
		}
		args := f.Calls[0].Args
		if !containsSeq(args, []string{"--tail", c.want}) {
			t.Errorf("tail=%d: want --tail %s, got %v", c.tail, c.want, args)
		}
	}
}

// Regression for #45 (finding #1241): container_inspect must surface
// State.OOMKilled and State.Error; the API's crash diagnostics read them
// and were always false/null.
func TestDockerInspectReportsOOMKilledAndError(t *testing.T) {
	raw := `{"Name":"/squad-019dbb45-3556-751f-9124-d4cf0e6b0053","RestartCount":2,` +
		`"State":{"Status":"exited","Running":false,"Pid":0,"ExitCode":137,"OOMKilled":true,` +
		`"Error":"container killed","StartedAt":"2026-01-01T00:00:00Z","FinishedAt":"2026-01-01T01:00:00Z"},` +
		`"Config":{"Image":"squad-server:latest","Labels":{"panel.kind":"squad-server"}}}`
	d := NewDocker(&Fake{Stdout: []byte(raw)})
	res, err := d.Inspect(context.Background(), "squad-019dbb45-3556-751f-9124-d4cf0e6b0053")
	if err != nil {
		t.Fatal(err)
	}
	if !res.OOMKilled || res.Error != "container killed" || res.ExitCode != 137 {
		t.Fatalf("inspect lost OOM/error state: %+v", res)
	}
	body, _ := json.Marshal(res)
	if !strings.Contains(string(body), `"oom_killed":true`) || !strings.Contains(string(body), `"error":"container killed"`) {
		t.Fatalf("wire JSON lacks oom_killed/error: %s", body)
	}

	clean := NewDocker(&Fake{Stdout: []byte(`{"Name":"/x","State":{"Status":"running","Running":true}}`)})
	res, err = clean.Inspect(context.Background(), "squad-019dbb45-3556-751f-9124-d4cf0e6b0053")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = json.Marshal(res)
	if !strings.Contains(string(body), `"oom_killed":false`) || strings.Contains(string(body), `"error"`) {
		t.Fatalf("healthy container must report oom_killed:false and omit error: %s", body)
	}
}

// Regression for #45 (finding #1243): ensureSidecarDir Fchowns sock/ to the
// sidecar uid and later Fchmods a directory the sidecar owns. Even root needs
// CAP_CHOWN and CAP_FOWNER for that, and systemd's CapabilityBoundingSet
// strips every capability it does not list (drop-ins only add to the set),
// so the unit itself must grant both or container_run_rnsquadjs fails with
// EPERM on every production install.
func TestBridgeUnitBoundingSetAllowsSidecarChown(t *testing.T) {
	unit, err := os.ReadFile(filepath.Join("..", "..", "deploy", "panel-host-bridge.service"))
	if err != nil {
		t.Fatal(err)
	}
	caps := map[string]bool{}
	for _, line := range strings.Split(string(unit), "\n") {
		if value, ok := strings.CutPrefix(strings.TrimSpace(line), "CapabilityBoundingSet="); ok {
			for _, c := range strings.Fields(value) {
				caps[c] = true
			}
		}
	}
	for _, want := range []string{"CAP_CHOWN", "CAP_FOWNER", "CAP_NET_ADMIN"} {
		if !caps[want] {
			t.Errorf("panel-host-bridge.service CapabilityBoundingSet lacks %s (have %v)", want, caps)
		}
	}
}
