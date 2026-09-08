package handlers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/runner"
)

const squadjs2HandlerUUID = "0196f0a2-1111-2222-3333-444444444444"

func TestContainerRunSquadjs2(t *testing.T) {
	root := t.TempDir()
	fake := &runner.Fake{Stdout: []byte("squadjs2-cid\n")}
	docker := runner.NewDocker(fake)
	docker.SquadJS2Root = root
	serverDir := filepath.Join(root, squadjs2HandlerUUID)
	if err := os.MkdirAll(serverDir, 0o750); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(serverDir, "config.json"), []byte("{}"), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	d := &Dispatcher{Docker: docker}

	params, _ := json.Marshal(map[string]any{
		"server_id": squadjs2HandlerUUID,
		"env":       map[string]string{"SERVER_ID": squadjs2HandlerUUID},
	})
	req := &rpc.Request{ID: "req-1", Method: "container_run_squadjs2", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})

	if !resp.OK {
		t.Fatalf("expected success, got %+v", resp.Error)
	}
	var body map[string]string
	if err := json.Unmarshal(resp.Result, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["container_id"] != "squadjs2-cid" || body["status"] != "started" {
		t.Fatalf("unexpected body %v", body)
	}
}

func TestContainerRunSquadjs2ForbiddenEnvIsForbidden(t *testing.T) {
	docker := runner.NewDocker(&runner.Fake{})
	docker.SquadJS2Root = t.TempDir()
	d := &Dispatcher{Docker: docker}

	params, _ := json.Marshal(map[string]any{
		"server_id": squadjs2HandlerUUID,
		"env":       map[string]string{"NODE_OPTIONS": "--inspect"},
	})
	req := &rpc.Request{ID: "req-2", Method: "container_run_squadjs2", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})

	if resp.OK {
		t.Fatal("expected error response")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}

// Deleting a server must be able to remove the sidecar config dir: it holds the
// rendered config.json with the server's plaintext RCON password.
func TestDirectoryDeleteAcceptsSidecarDirs(t *testing.T) {
	d := &Dispatcher{}
	for _, path := range []string{
		"/run/squad-panel/squadjs2/00000000-0000-7000-8000-000000000999",
		"/run/squad-panel/rnsquadjs/00000000-0000-7000-8000-000000000999",
	} {
		params, _ := json.Marshal(map[string]string{"path": path})
		req := &rpc.Request{ID: "req-3", Method: "directory_delete", Params: params}
		resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
		if !resp.OK {
			t.Fatalf("path %q rejected: %+v", path, resp.Error)
		}
	}
}

func TestDirectoryDeleteStillRejectsSidecarRoots(t *testing.T) {
	d := &Dispatcher{}
	for _, path := range []string{
		"/run/squad-panel/squadjs2",
		"/run/squad-panel/rnsquadjs",
		"/run/squad-panel",
		"/run/squad-panel/squadjs2/00000000-0000-7000-8000-000000000999/config.json",
	} {
		params, _ := json.Marshal(map[string]string{"path": path})
		req := &rpc.Request{ID: "req-4", Method: "directory_delete", Params: params}
		resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
		if resp.OK {
			t.Fatalf("path %q must be rejected", path)
		}
		if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
			t.Fatalf("path %q rejected with %+v, want CodeForbidden", path, resp.Error)
		}
	}
}
