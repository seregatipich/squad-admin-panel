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

func TestRunRNSquadJS_ComposesExpectedDockerArgs(t *testing.T) {
	f := &Fake{Stdout: []byte("rns-container-id\n")}
	d := NewDocker(f)
	id := "019dbaa5-1234-7abc-8def-0123456789ab"
	out, err := d.RunRNSquadJS(context.Background(), RNSquadJSRunSpec{
		ServerID: id,
		Env: map[string]string{
			"SERVER_ID": id,
			"API_URL":   "http://api:3000",
		},
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if out != "rns-container-id" {
		t.Errorf("expected rns-container-id, got %q", out)
	}
	if len(f.Calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(f.Calls))
	}
	args := strings.Join(f.Calls[0].Args, " ")
	for _, must := range []string{
		"run -d",
		"--name rnsquadjs-" + id,
		"--label panel.server_id=" + id,
		"--label panel.kind=rnsquadjs",
		"--network host",
		"--user 1001:1001",
		"--read-only",
		"--restart unless-stopped",
		"-v /var/lib/squad-panel/saved/" + id + "/SquadGame/Saved/Logs:/squad/Logs:ro",
		"-v /run/squad-panel/rnsquadjs:/run/panelBridge:rw",
		"-e API_URL=http://api:3000",
		"-e SERVER_ID=" + id,
		"squad-panel/rnsquadjs:latest",
	} {
		if !strings.Contains(args, must) {
			t.Errorf("expected args to contain %q, got: %s", must, args)
		}
	}
}

func TestRunRNSquadJS_RejectsBadServerID(t *testing.T) {
	f := &Fake{}
	d := NewDocker(f)
	if _, err := d.RunRNSquadJS(context.Background(), RNSquadJSRunSpec{ServerID: "../etc"}); err == nil {
		t.Fatal("expected rejection")
	}
	if len(f.Calls) != 0 {
		t.Errorf("expected 0 calls on rejection, got %d", len(f.Calls))
	}
}
