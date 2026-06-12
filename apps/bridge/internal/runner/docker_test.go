package runner

import (
	"context"
	"strings"
	"testing"
)

func TestDockerRunComposesCommand(t *testing.T) {
	f := &Fake{Stdout: []byte("containerid\n")}
	d := NewDocker(f)
	spec := ContainerRunSpec{
		ServerID:    "019dbb45-3556-751f-9124-d4cf0e6b0053",
		Image:       "squad-server:latest",
		GamePort:    7788,
		QueryPort:   27166,
		BeaconPort:  15001,
		RCONPort:    21115,
		MaxPlayers:  20,
		Tickrate:    50,
		Multihome:   "0.0.0.0",
		ConfigsHost: "/var/lib/squad-panel/configs/019dbb45-3556-751f-9124-d4cf0e6b0053/ServerConfig",
		SavedHost:   "/var/lib/squad-panel/saved/019dbb45-3556-751f-9124-d4cf0e6b0053",
		DepotVolume: "squad-depot",
	}
	out, err := d.Run(context.Background(), spec)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if out != "containerid" {
		t.Errorf("expected containerid, got %q", out)
	}
	if len(f.Calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(f.Calls))
	}
	args := strings.Join(f.Calls[0].Args, " ")
	for _, must := range []string{
		"--pull never",
		"--network host",
		"--name squad-019dbb45-3556-751f-9124-d4cf0e6b0053",
		"squad-depot:/squad:ro",
		"/var/lib/squad-panel/configs/019dbb45-3556-751f-9124-d4cf0e6b0053/ServerConfig:/squad/SquadGame/ServerConfig:rw",
		"panel.server_id=019dbb45-3556-751f-9124-d4cf0e6b0053",
		"Port=7788",
		"RCONPORT=21115",
		"FIXEDMAXPLAYERS=20",
	} {
		if !strings.Contains(args, must) {
			t.Errorf("expected args to contain %q, got: %s", must, args)
		}
	}
}

// TestDockerRunPullNeverPreventsRegistryPull guards the explicit `--pull never`
// flag added so that a missing local image returns a clean error instead of
// docker reaching out to Docker Hub for `squad-server:latest` (which would
// fail with `pull access denied`).
func TestDockerRunPullNeverPreventsRegistryPull(t *testing.T) {
	f := &Fake{Stdout: []byte("cid\n")}
	d := NewDocker(f)
	spec := ContainerRunSpec{
		ServerID:    "019dbb45-3556-751f-9124-d4cf0e6b0053",
		Image:       "squad-server:latest",
		GamePort:    7788,
		QueryPort:   27166,
		BeaconPort:  15001,
		RCONPort:    21115,
		MaxPlayers:  20,
		Tickrate:    50,
		Multihome:   "0.0.0.0",
		ConfigsHost: "/var/lib/squad-panel/configs/019dbb45-3556-751f-9124-d4cf0e6b0053/ServerConfig",
		SavedHost:   "/var/lib/squad-panel/saved/019dbb45-3556-751f-9124-d4cf0e6b0053",
		DepotVolume: "squad-depot",
	}
	if _, err := d.Run(context.Background(), spec); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	args := f.Calls[0].Args
	// `--pull` and `never` MUST be adjacent to form a single docker flag.
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--pull" {
			if args[i+1] != "never" {
				t.Fatalf("--pull followed by %q, want never", args[i+1])
			}
			return
		}
	}
	t.Fatalf("--pull never not found in args: %v", args)
}

func TestDockerRunRejectsBadImage(t *testing.T) {
	d := NewDocker(&Fake{})
	spec := ContainerRunSpec{
		ServerID: "019dbb45-3556-751f-9124-d4cf0e6b0053",
		Image:    "alpine:latest",
	}
	if _, err := d.Run(context.Background(), spec); err == nil {
		t.Errorf("expected error for non-allowlisted image")
	}
}

func TestDockerRunRejectsBadMount(t *testing.T) {
	d := NewDocker(&Fake{})
	spec := ContainerRunSpec{
		ServerID:    "019dbb45-3556-751f-9124-d4cf0e6b0053",
		Image:       "squad-server:latest",
		ConfigsHost: "/etc/passwd",
		SavedHost:   "/var/lib/squad-panel/saved/019dbb45-3556-751f-9124-d4cf0e6b0053",
		DepotVolume: "squad-depot",
	}
	if _, err := d.Run(context.Background(), spec); err == nil {
		t.Errorf("expected error for /etc/passwd mount")
	}
}

func TestDockerStopIdempotent(t *testing.T) {
	f := &Fake{Stderr: []byte("Error: No such container: foo\n"), Exit: 1}
	d := NewDocker(f)
	if err := d.Stop(context.Background(), "squad-019dbb45-3556-751f-9124-d4cf0e6b0053", 0); err != nil {
		t.Errorf("expected idempotent stop on missing container, got %v", err)
	}
}

func TestDockerStatsParsesOutput(t *testing.T) {
	line := `{"Name":"/squad-019dbb45-3556-751f-9124-d4cf0e6b0053","CPUPerc":"37.5%","MemUsage":"1.5GiB / 4GiB","MemPerc":"37.50%","PIDs":"42"}` + "\n"
	f := &Fake{Stdout: []byte(line)}
	d := NewDocker(f)
	res, err := d.Stats(context.Background(), "squad-019dbb45-3556-751f-9124-d4cf0e6b0053")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !res.Found {
		t.Fatalf("expected Found=true")
	}
	if res.CPUPercent != 37.5 {
		t.Errorf("cpu: want 37.5, got %v", res.CPUPercent)
	}
	wantMem := int64(float64(1.5) * 1024 * 1024 * 1024)
	if res.MemUsedBytes != wantMem {
		t.Errorf("mem used: want %d, got %d", wantMem, res.MemUsedBytes)
	}
	if res.MemLimitBytes != 4*1024*1024*1024 {
		t.Errorf("mem limit: want 4GiB, got %d", res.MemLimitBytes)
	}
	if res.Pids != 42 {
		t.Errorf("pids: want 42, got %d", res.Pids)
	}
}

func TestDockerStatsMissingContainer(t *testing.T) {
	f := &Fake{Stderr: []byte("Error response from daemon: No such container: squad-x\n"), Exit: 1}
	d := NewDocker(f)
	res, err := d.Stats(context.Background(), "squad-019dbb45-3556-751f-9124-d4cf0e6b0053")
	if err != nil {
		t.Fatalf("expected graceful handling of missing container, got %v", err)
	}
	if res.Found {
		t.Errorf("expected Found=false for missing container")
	}
}

func TestDockerStatsRejectsBadName(t *testing.T) {
	d := NewDocker(&Fake{})
	if _, err := d.Stats(context.Background(), "../etc/passwd"); err == nil {
		t.Errorf("expected validate.ContainerName to reject traversal name")
	}
}

// Regression test for the "Server stuck on 'Остановка' for 2 hours" incident:
// Docker writes "no such object" with lowercase 'n' for `docker inspect` when
// the container is gone. The previous matcher only checked for the
// upper-cased "No such object" form, so the bridge propagated a runtime_error
// to the reconciler instead of returning State="not_found", which the
// reconciler can flip to status='stopped'.
func TestDockerInspectLowercaseNoSuchObjectIsNotFound(t *testing.T) {
	f := &Fake{Stderr: []byte("error: no such object: squad-foo\n"), Exit: 1}
	d := NewDocker(f)
	res, err := d.Inspect(context.Background(), "squad-019dbb45-3556-751f-9124-d4cf0e6b0053")
	if err != nil {
		t.Fatalf("expected lowercase 'no such object' to be treated as not_found, got %v", err)
	}
	if res.State != "not_found" {
		t.Errorf("state: want not_found, got %q", res.State)
	}
	if res.Running {
		t.Errorf("running: want false, got true")
	}
}

func TestDockerInspectUppercaseNoSuchObjectIsNotFound(t *testing.T) {
	f := &Fake{Stderr: []byte("Error: No such object: squad-foo\n"), Exit: 1}
	d := NewDocker(f)
	res, err := d.Inspect(context.Background(), "squad-019dbb45-3556-751f-9124-d4cf0e6b0053")
	if err != nil {
		t.Fatalf("expected 'No such object' to be treated as not_found, got %v", err)
	}
	if res.State != "not_found" {
		t.Errorf("state: want not_found, got %q", res.State)
	}
}

func TestDockerStopLowercaseNoSuchContainerIsIdempotent(t *testing.T) {
	f := &Fake{Stderr: []byte("error: no such container: foo\n"), Exit: 1}
	d := NewDocker(f)
	if err := d.Stop(context.Background(), "squad-019dbb45-3556-751f-9124-d4cf0e6b0053", 0); err != nil {
		t.Errorf("expected idempotent stop on missing container (lowercase), got %v", err)
	}
}

func TestDockerRmLowercaseNoSuchContainerIsIdempotent(t *testing.T) {
	f := &Fake{Stderr: []byte("error: no such container: foo\n"), Exit: 1}
	d := NewDocker(f)
	if err := d.Rm(context.Background(), "squad-019dbb45-3556-751f-9124-d4cf0e6b0053"); err != nil {
		t.Errorf("expected idempotent rm on missing container (lowercase), got %v", err)
	}
}
