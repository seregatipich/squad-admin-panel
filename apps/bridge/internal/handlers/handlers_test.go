package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

func TestValidateReadablePath_AcceptsConfigsAndSaved(t *testing.T) {
	cases := []string{
		"/var/lib/squad-panel/configs/019dbaa5-1234-7abc-8def-0123456789ab/ServerConfig/Admins.cfg",
		"/var/lib/squad-panel/saved/019dbaa5-1234-7abc-8def-0123456789ab/SquadGame/Saved/Logs/SquadGame.log",
	}
	for _, p := range cases {
		if err := validateReadablePath(p); err != nil {
			t.Errorf("expected %q allowed, got %v", p, err)
		}
	}
}

func TestValidateReadablePath_DepotDefault(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "")
	if err := validateReadablePath("/var/lib/docker/volumes/squad-depot/SquadGame/ServerConfig/Admins.cfg"); err != nil {
		t.Errorf("expected default depot root allowed, got %v", err)
	}
}

func TestValidateReadablePath_DepotHonorsEnv(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "/opt/panel-data/depot")
	if err := validateReadablePath("/opt/panel-data/depot/SquadGame/ServerConfig/Admins.cfg"); err != nil {
		t.Errorf("expected env-override depot root allowed, got %v", err)
	}
}

func TestValidateReadablePath_RejectsOutsideRoots(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "/opt/panel-data/depot")
	cases := []string{
		"/etc/shadow",
		"/var/lib/squad-panel/../etc/passwd",
		"/opt/panel-data/depot/../../etc/shadow",
		"/home/squad/.ssh/authorized_keys",
	}
	for _, p := range cases {
		err := validateReadablePath(p)
		if err == nil {
			t.Errorf("expected rejection for %q", p)
			continue
		}
		if !errors.Is(err, validate.ErrForbidden) {
			t.Errorf("expected ErrForbidden for %q, got %v", p, err)
		}
	}
}

func TestValidateWritablePath_AcceptsConfigsOnly(t *testing.T) {
	ok := "/var/lib/squad-panel/configs/019dbaa5-1234-7abc-8def-0123456789ab/ServerConfig/Admins.cfg"
	if err := validateWritablePath(ok); err != nil {
		t.Errorf("expected %q writable, got %v", ok, err)
	}
}

func TestValidateWritablePath_RejectsDepot(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "/opt/panel-data/depot")
	bad := "/opt/panel-data/depot/SquadGame/ServerConfig/Admins.cfg"
	if err := validateWritablePath(bad); err == nil {
		t.Errorf("expected rejection for depot-write %q", bad)
	}
}

func TestHostAgentRestart_RespondsBeforeExec(t *testing.T) {
	execCalled := make(chan []string, 1)
	var execCount atomic.Int32

	d := &Dispatcher{
		restartDelay: 30 * time.Millisecond,
		RestartCommand: func() *exec.Cmd {
			execCount.Add(1)
			args := []string{"systemctl", "restart", "panel-host-bridge.service"}
			execCalled <- args
			// Use a no-op command so Start() succeeds without launching systemctl.
			return exec.Command("true")
		},
	}

	req := &rpc.Request{ID: "req-1", Method: "host_agent_restart"}
	respondedAt := time.Now()
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	respDuration := time.Since(respondedAt)

	if !resp.OK {
		t.Fatalf("expected OK response, got error: %+v", resp.Error)
	}
	var body map[string]string
	if err := json.Unmarshal(resp.Result, &body); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if body["status"] != "restarting" {
		t.Fatalf("expected status=restarting, got %q", body["status"])
	}
	if execCount.Load() != 0 {
		t.Fatalf("exec ran before response was returned (count=%d)", execCount.Load())
	}
	// Sanity: Handle should return well under the 30ms restart delay.
	if respDuration >= 30*time.Millisecond {
		t.Fatalf("handler took %v; should return immediately", respDuration)
	}

	select {
	case args := <-execCalled:
		want := []string{"systemctl", "restart", "panel-host-bridge.service"}
		if len(args) != len(want) {
			t.Fatalf("exec args = %v, want %v", args, want)
		}
		for i := range want {
			if args[i] != want[i] {
				t.Fatalf("exec args[%d] = %q, want %q", i, args[i], want[i])
			}
		}
	case <-time.After(2 * time.Second):
		t.Fatal("exec was never invoked after response delay")
	}
}
