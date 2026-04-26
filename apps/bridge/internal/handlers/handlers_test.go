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

func TestValidateDeletableDir_AcceptsConfigsAndSavedRoots(t *testing.T) {
	uuid := "019dbaa5-1234-7abc-8def-0123456789ab"
	cases := []string{
		"/var/lib/squad-panel/configs/" + uuid,
		"/var/lib/squad-panel/saved/" + uuid,
	}
	for _, p := range cases {
		cleaned, err := validateDeletableDir(p)
		if err != nil {
			t.Errorf("expected %q allowed, got %v", p, err)
		}
		if cleaned != p {
			t.Errorf("cleaned = %q, want %q", cleaned, p)
		}
	}
}

func TestValidateDeletableDir_RejectsEverythingElse(t *testing.T) {
	uuid := "019dbaa5-1234-7abc-8def-0123456789ab"
	cases := []string{
		"",
		"/etc/passwd",
		"/var/lib/squad-panel",
		"/var/lib/squad-panel/configs",
		"/var/lib/squad-panel/configs/" + uuid + "/ServerConfig",
		"/var/lib/squad-panel/configs/" + uuid + "/ServerConfig/Server.cfg",
		"/var/lib/squad-panel/saved/" + uuid + "/Logs/SquadGame.log",
		"/var/lib/squad-panel/configs/../etc",
		"/var/lib/squad-panel/configs/not-a-uuid",
		"/var/lib/docker/volumes/squad-depot/_data",
	}
	for _, p := range cases {
		_, err := validateDeletableDir(p)
		if err == nil {
			t.Errorf("expected rejection for %q", p)
			continue
		}
		if !errors.Is(err, validate.ErrForbidden) {
			t.Errorf("expected ErrForbidden for %q, got %v", p, err)
		}
	}
}

func TestDirectoryDelete_ForbiddenPathReturnsForbidden(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]string{"path": "/etc/passwd"})
	req := &rpc.Request{ID: "req-1", Method: "directory_delete", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}

func TestDirectoryDelete_FilePathUnderConfigsForbidden(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]string{
		"path": "/var/lib/squad-panel/configs/019dbaa5-1234-7abc-8def-0123456789ab/ServerConfig/Server.cfg",
	})
	req := &rpc.Request{ID: "req-2", Method: "directory_delete", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}

func TestDirectoryDelete_NonExistentValidPathIsIdempotent(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]string{
		"path": "/var/lib/squad-panel/configs/00000000-0000-7000-8000-000000000999",
	})
	req := &rpc.Request{ID: "req-3", Method: "directory_delete", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected success for non-existent valid path, got %+v", resp.Error)
	}
	var body map[string]bool
	if err := json.Unmarshal(resp.Result, &body); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if body["removed"] != false {
		t.Fatalf("expected removed=false for non-existent path, got %v", body)
	}
}

func TestDirectoryDelete_TraversalForbidden(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]string{
		"path": "/var/lib/squad-panel/configs/../etc",
	})
	req := &rpc.Request{ID: "req-4", Method: "directory_delete", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}

func TestDirectoryDelete_BadUUIDForbidden(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]string{
		"path": "/var/lib/squad-panel/configs/not-a-uuid",
	})
	req := &rpc.Request{ID: "req-5", Method: "directory_delete", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}

func TestDirectoryDelete_InvalidJSONReturnsInvalidArgs(t *testing.T) {
	d := &Dispatcher{}
	req := &rpc.Request{ID: "req-6", Method: "directory_delete", Params: []byte("not-json")}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeInvalidArgs {
		t.Fatalf("expected CodeInvalidArgs, got %+v", resp.Error)
	}
}

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

func TestValidateReadablePath_AcceptsSentinel(t *testing.T) {
	if err := validateReadablePath("/var/lib/squad-panel/.first-owner-claimed"); err != nil {
		t.Errorf("expected sentinel readable, got %v", err)
	}
}

func TestValidateReadablePath_RejectsSentinelNeighbours(t *testing.T) {
	cases := []string{
		"/var/lib/squad-panel/.first-owner-claim",
		"/var/lib/squad-panel/something-else",
		"/var/lib/squad-panel/.first-owner-claimed/extra",
	}
	for _, p := range cases {
		if err := validateReadablePath(p); err == nil {
			t.Errorf("expected rejection for %q", p)
		}
	}
}

func TestValidateWritablePath_AcceptsSentinel(t *testing.T) {
	if err := validateWritablePath("/var/lib/squad-panel/.first-owner-claimed"); err != nil {
		t.Errorf("expected sentinel writable, got %v", err)
	}
}

func TestValidateWritablePath_RejectsSentinelNeighbours(t *testing.T) {
	cases := []string{
		"/var/lib/squad-panel/.first-owner-claim",
		"/var/lib/squad-panel/something-else",
	}
	for _, p := range cases {
		if err := validateWritablePath(p); err == nil {
			t.Errorf("expected rejection for %q", p)
		}
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
