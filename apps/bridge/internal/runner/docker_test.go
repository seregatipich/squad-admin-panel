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
