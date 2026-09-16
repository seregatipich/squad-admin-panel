package runner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/validate"
)

const squadjs2TestID = "0196f0a2-1111-2222-3333-444444444444"

func TestComposeSquadJS2Args(t *testing.T) {
	d := &DockerRunner{}
	spec := SquadJS2RunSpec{
		ServerID: squadjs2TestID,
		Env: map[string]string{
			"SERVER_ID": squadjs2TestID,
			"LOG_FILE":  "/squad/Logs/SquadGame.log",
		},
	}
	args, err := d.composeSquadJS2Args(spec)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"--name squadjs2-" + squadjs2TestID,
		"--label panel.kind=squadjs2",
		"--label panel.server_id=" + squadjs2TestID,
		"--network host",
		"--read-only",
		"--user 1001:1001",
		"--restart unless-stopped",
		"--pull never",
		"-v /var/lib/squad-panel/saved/" + squadjs2TestID + "/SquadGame/Saved/Logs:/squad/Logs:ro",
		"-v /run/squad-panel/squadjs2/" + squadjs2TestID + "/config.json:/app/panel-config.json:ro",
		"-e LOG_FILE=/squad/Logs/SquadGame.log",
		"-e SERVER_ID=" + squadjs2TestID,
		"squad-panel/squadjs2:latest",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q\nargs: %s", want, joined)
		}
	}
	// env must be deterministic (sorted by key)
	if strings.Index(joined, "LOG_FILE=") > strings.Index(joined, "SERVER_ID=") {
		t.Fatal("env args must be sorted by key")
	}
}

// The Unix-socket RCON server of the rnsquadjs bridge was dead code and is not
// carried over, so the SquadJS2 container must have no writable mount at all.
func TestComposeSquadJS2ArgsHasNoWritableMount(t *testing.T) {
	d := &DockerRunner{}
	args, err := d.composeSquadJS2Args(SquadJS2RunSpec{ServerID: squadjs2TestID})
	if err != nil {
		t.Fatal(err)
	}
	for i, arg := range args {
		if arg != "-v" {
			continue
		}
		if !strings.HasSuffix(args[i+1], ":ro") {
			t.Fatalf("bind %q is not read-only", args[i+1])
		}
	}
	if strings.Contains(strings.Join(args, " "), "/run/panelBridge") {
		t.Fatal("squadjs2 sidecar must not mount the rnsquadjs socket dir")
	}
}

func TestComposeSquadJS2ArgsStillEmitsImage(t *testing.T) {
	d := &DockerRunner{}
	args, err := d.composeSquadJS2Args(SquadJS2RunSpec{ServerID: squadjs2TestID})
	if err != nil {
		t.Fatal(err)
	}
	if last := args[len(args)-1]; last != validate.SquadJS2Image {
		t.Fatalf("final arg = %q, want hardcoded %q", last, validate.SquadJS2Image)
	}
}

func TestComposeSquadJS2ArgsRejectsBadUUID(t *testing.T) {
	d := &DockerRunner{}
	for _, id := range []string{"", "not-a-uuid", "../../etc", squadjs2TestID + "x"} {
		if _, err := d.composeSquadJS2Args(SquadJS2RunSpec{ServerID: id}); err == nil {
			t.Fatalf("expected rejection for server id %q", id)
		}
	}
}

// The SquadJS2 sidecar takes mode/redisUrl/serverId from the rendered config,
// so its env allowlist is narrower than the rnsquadjs one: everything the old
// bridge passed through env must now be refused.
func TestComposeSquadJS2ArgsEnvAllowlist(t *testing.T) {
	d := &DockerRunner{}
	for _, key := range []string{
		"PANEL_BRIDGE_MODE",
		"PANEL_BRIDGE_SOCKET",
		"REDIS_URL",
		"NODE_OPTIONS",
		"LD_PRELOAD",
		"",
	} {
		_, err := d.composeSquadJS2Args(SquadJS2RunSpec{
			ServerID: squadjs2TestID,
			Env:      map[string]string{key: "x"},
		})
		if err == nil {
			t.Fatalf("expected env key %q to be rejected", key)
		}
		if !errors.Is(err, validate.ErrForbidden) {
			t.Fatalf("env key %q rejected with %v, want ErrForbidden", key, err)
		}
	}
}

func TestComposeSquadJS2ArgsRejectsControlCharacters(t *testing.T) {
	d := &DockerRunner{}
	for _, value := range []string{"a\nb", "a\rb", "a\x00b"} {
		_, err := d.composeSquadJS2Args(SquadJS2RunSpec{
			ServerID: squadjs2TestID,
			Env:      map[string]string{"LOG_FILE": value},
		})
		if !errors.Is(err, validate.ErrForbidden) {
			t.Fatalf("value %q rejected with %v, want ErrForbidden", value, err)
		}
	}
}

func TestRunSquadJS2(t *testing.T) {
	root := t.TempDir()
	f := &Fake{Stdout: []byte("squadjs2-container-id\n")}
	d := NewDocker(f)
	d.SquadJS2Root = root
	spec := SquadJS2RunSpec{
		ServerID: squadjs2TestID,
		Env:      map[string]string{"SERVER_ID": squadjs2TestID},
	}
	serverDir := filepath.Join(root, spec.ServerID)
	if err := os.MkdirAll(serverDir, 0o750); err != nil {
		t.Fatalf("mkdir server dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(serverDir, "config.json"), []byte("{}"), 0o600); err != nil {
		t.Fatalf("write config.json: %v", err)
	}
	wantArgs, err := d.composeSquadJS2Args(spec)
	if err != nil {
		t.Fatalf("composeSquadJS2Args: %v", err)
	}
	id, err := d.RunSquadJS2(context.Background(), spec)
	if err != nil {
		t.Fatalf("RunSquadJS2: %v", err)
	}
	if id != "squadjs2-container-id" {
		t.Errorf("id = %q, want squadjs2-container-id", id)
	}
	if len(f.Calls) != 1 {
		t.Fatalf("expected 1 docker call, got %d", len(f.Calls))
	}
	if !reflect.DeepEqual(f.Calls[0].Args, wantArgs) {
		t.Fatalf("docker called with\n  %v\nwant\n  %v", f.Calls[0].Args, wantArgs)
	}
	info, err := os.Stat(serverDir)
	if err != nil {
		t.Fatalf("stat server dir: %v", err)
	}
	if info.Mode().Perm() != 0o750 {
		t.Errorf("server dir perm = %o, want 750", info.Mode().Perm())
	}
	if info.Mode()&os.ModeSetgid != 0 {
		t.Errorf("server dir must not carry setgid (RestrictSUIDSGID=yes): mode %v", info.Mode())
	}
	// No sidecar-writable subdirectory is created at all.
	if _, err := os.Stat(filepath.Join(serverDir, "sock")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("squadjs2 sidecar must not create a sock dir, stat err = %v", err)
	}
}

func TestRunSquadJS2RequiresRenderedConfig(t *testing.T) {
	root := t.TempDir()
	f := &Fake{Stdout: []byte("id\n")}
	d := NewDocker(f)
	d.SquadJS2Root = root
	_, err := d.RunSquadJS2(context.Background(), SquadJS2RunSpec{ServerID: squadjs2TestID})
	if err == nil || !strings.Contains(err.Error(), "config.json not rendered") {
		t.Fatalf("err = %v, want config.json not rendered", err)
	}
	if len(f.Calls) != 0 {
		t.Fatalf("docker must not run without a rendered config, calls = %d", len(f.Calls))
	}
}

func TestEnsureSquadJS2DirRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	target := t.TempDir()
	d := NewDocker(&Fake{})
	d.SquadJS2Root = root
	if err := os.Symlink(target, filepath.Join(root, squadjs2TestID)); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	err := d.ensureSquadJS2Dir(squadjs2TestID)
	if !errors.Is(err, validate.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

func TestEnsureSquadJS2DirIsIdempotent(t *testing.T) {
	root := t.TempDir()
	d := NewDocker(&Fake{})
	d.SquadJS2Root = root
	for range 2 {
		if err := d.ensureSquadJS2Dir(squadjs2TestID); err != nil {
			t.Fatalf("ensureSquadJS2Dir: %v", err)
		}
	}
	info, err := os.Stat(filepath.Join(root, squadjs2TestID))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o750 {
		t.Errorf("perm = %o, want 750", info.Mode().Perm())
	}
}
