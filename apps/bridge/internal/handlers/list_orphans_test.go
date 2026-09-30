package handlers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/runner"
)

const orphanTestUUID = "019dbaa5-1234-7abc-8def-0123456789ab"

// The API's orphan sweep needs the RNSquadJS sidecar containers alongside the
// game-server containers, so a sidecar whose server row is gone (and whose
// config dir holds a plaintext RCON password) can be removed (#66).
func TestListSquadContainersReportsSidecars(t *testing.T) {
	f := &runner.Fake{}
	f.OnRun = func(call runner.FakeCall) {
		args := strings.Join(call.Args, " ")
		switch {
		case strings.Contains(args, "name=^rnsquadjs-"):
			f.Stdout = []byte("rnsquadjs-" + orphanTestUUID + "\nrnsquadjs-not-a-uuid\n")
		case strings.Contains(args, "name=^squad-"):
			f.Stdout = []byte("squad-" + orphanTestUUID + "\n")
		default:
			f.Stdout = nil
		}
	}
	d := &Dispatcher{Docker: runner.NewDocker(f)}
	req := &rpc.Request{ID: "req-list-containers", Method: "list_squad_containers"}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected success, got %+v", resp.Error)
	}
	var body struct {
		Containers []string `json:"containers"`
		Sidecars   []string `json:"sidecars"`
	}
	if err := json.Unmarshal(resp.Result, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Containers) != 1 || body.Containers[0] != "squad-"+orphanTestUUID {
		t.Errorf("containers = %v", body.Containers)
	}
	if len(body.Sidecars) != 1 || body.Sidecars[0] != "rnsquadjs-"+orphanTestUUID {
		t.Errorf("sidecars = %v, want only the strictly named sidecar", body.Sidecars)
	}
}

func TestListPanelDirsReportsSidecarDirs(t *testing.T) {
	base := t.TempDir()
	roots := panelDirRoots
	t.Cleanup(func() { panelDirRoots = roots })
	panelDirRoots = panelDirListing{
		Configs:  filepath.Join(base, "configs"),
		Saved:    filepath.Join(base, "saved"),
		Sidecars: filepath.Join(base, "rnsquadjs"),
	}
	if err := os.MkdirAll(filepath.Join(panelDirRoots.Sidecars, orphanTestUUID), 0o700); err != nil {
		t.Fatal(err)
	}

	d := &Dispatcher{}
	req := &rpc.Request{ID: "req-list-dirs", Method: "list_panel_dirs"}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected success, got %+v", resp.Error)
	}
	var body struct {
		Configs  []string `json:"configs"`
		Saved    []string `json:"saved"`
		Sidecars []string `json:"sidecars"`
	}
	if err := json.Unmarshal(resp.Result, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Configs) != 0 || len(body.Saved) != 0 {
		t.Errorf("configs = %v, saved = %v; want both empty for missing roots", body.Configs, body.Saved)
	}
	if len(body.Sidecars) != 1 || body.Sidecars[0] != orphanTestUUID {
		t.Errorf("sidecars = %v, want [%s]", body.Sidecars, orphanTestUUID)
	}
}
