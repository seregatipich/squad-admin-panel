package runner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
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

func TestComposeRNSquadJSArgs(t *testing.T) {
	d := &DockerRunner{}
	spec := RNSquadJSRunSpec{
		ServerID: "0196f0a2-1111-2222-3333-444444444444",
		Env: map[string]string{
			"SERVER_ID":         "0196f0a2-1111-2222-3333-444444444444",
			"PANEL_BRIDGE_MODE": "shadow",
		},
	}
	args, err := d.composeRNSquadJSArgs(spec)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"--name rnsquadjs-0196f0a2-1111-2222-3333-444444444444",
		"--network host",
		"--read-only",
		"--user 1001:1001",
		"--restart unless-stopped",
		"--pull never",
		"-v /var/lib/squad-panel/saved/0196f0a2-1111-2222-3333-444444444444/SquadGame/Saved/Logs:/squad/Logs:ro",
		"-v /run/squad-panel/rnsquadjs/0196f0a2-1111-2222-3333-444444444444/sock:/run/panelBridge:rw",
		"-v /run/squad-panel/rnsquadjs/0196f0a2-1111-2222-3333-444444444444/config.json:/app/config.json:ro",
		"-e PANEL_BRIDGE_MODE=shadow",
		"-e SERVER_ID=0196f0a2-1111-2222-3333-444444444444",
		"squad-panel/rnsquadjs:latest",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q\nargs: %s", want, joined)
		}
	}
	// env must be deterministic (sorted by key)
	modeIdx := strings.Index(joined, "PANEL_BRIDGE_MODE")
	idIdx := strings.Index(joined, "SERVER_ID=")
	if modeIdx > idIdx {
		t.Fatal("env args must be sorted by key")
	}
}

// TestComposeRNSquadJSArgsStillEmitsImage guards Fix 1: even though the
// sidecar image is removed from the generic container_run allowlist, the
// specialized rnsquadjs launch must still hardcode it as the final docker
// argument (the image is a constant here, never caller-supplied).
func TestComposeRNSquadJSArgsStillEmitsImage(t *testing.T) {
	d := &DockerRunner{}
	spec := RNSquadJSRunSpec{ServerID: "0196f0a2-1111-2222-3333-444444444444"}
	args, err := d.composeRNSquadJSArgs(spec)
	if err != nil {
		t.Fatal(err)
	}
	if last := args[len(args)-1]; last != validate.RNSquadJSImage {
		t.Fatalf("final arg = %q, want hardcoded %q", last, validate.RNSquadJSImage)
	}
}

func TestComposeRNSquadJSArgsRejectsBadUUID(t *testing.T) {
	d := &DockerRunner{}
	if _, err := d.composeRNSquadJSArgs(RNSquadJSRunSpec{ServerID: "not-a-uuid"}); err == nil {
		t.Fatal("expected bad uuid rejected")
	}
}

// TestComposeRNSquadJSArgsEnvAllowlist covers Fix 4: caller-supplied env keys
// are confined to a fixed allowlist and neither keys nor values may smuggle
// control characters or an '=' into the key.
func TestComposeRNSquadJSArgsEnvAllowlist(t *testing.T) {
	const id = "0196f0a2-1111-2222-3333-444444444444"
	rejected := map[string]map[string]string{
		"NODE_OPTIONS not allowlisted": {"NODE_OPTIONS": "--inspect"},
		"LD_PRELOAD not allowlisted":   {"LD_PRELOAD": "/tmp/evil.so"},
		"key with equals":              {"SERVER_ID=x": "y"},
		"value with newline":           {"LOG_FILE": "a\nb"},
		"value with carriage return":   {"LOG_FILE": "a\rb"},
		"value with NUL":               {"LOG_FILE": "a\x00b"},
		"empty key":                    {"": "x"},
	}
	for label, env := range rejected {
		d := &DockerRunner{}
		_, err := d.composeRNSquadJSArgs(RNSquadJSRunSpec{ServerID: id, Env: env})
		if err == nil || !errors.Is(err, validate.ErrForbidden) {
			t.Fatalf("%s: expected ErrForbidden, got %v", label, err)
		}
	}

	d := &DockerRunner{}
	accepted := map[string]string{
		"SERVER_ID":           id,
		"LOG_FILE":            "/squad/Logs/SquadGame.log",
		"PANEL_BRIDGE_MODE":   "shadow",
		"PANEL_BRIDGE_SOCKET": "/run/panelBridge/rcon.sock",
		"REDIS_URL":           "redis://user:pass@127.0.0.1:6379/0",
	}
	if _, err := d.composeRNSquadJSArgs(RNSquadJSRunSpec{ServerID: id, Env: accepted}); err != nil {
		t.Fatalf("standard five env keys must be accepted, got %v", err)
	}
}

// TestValidateSidecarEnvControlCharacters is the regression guard for the
// broken-charset bug: the forbidden set must be the Go escape "\x00\n\r" (real
// NUL/LF/CR), not the literal letters 'x','0','n','r'. With the buggy literal
// form every redis URL is rejected (it contains 'r' and '0') while a real
// newline would slip through. The plain redis URL acceptance below FAILS
// against the buggy literal charset, proving the bug, and the real-control-char
// rejections FAIL if the charset is ever weakened to literals.
func TestValidateSidecarEnvControlCharacters(t *testing.T) {
	if err := validateSidecarEnv(map[string]string{"REDIS_URL": "redis://127.0.0.1:6379"}); err != nil {
		t.Fatalf("plain redis URL must be accepted (contains 'r' and '0'), got %v", err)
	}

	rejected := []struct {
		name string
		env  map[string]string
	}{
		{"value newline", map[string]string{"LOG_FILE": "a\nb"}},
		{"value carriage return", map[string]string{"LOG_FILE": "a\rb"}},
		{"value NUL", map[string]string{"LOG_FILE": "a\x00b"}},
		{"key newline", map[string]string{"LOG_FILE\nINJECT": "x"}},
		{"key equals", map[string]string{"PANEL_BRIDGE_MODE=x": "y"}},
	}
	for _, tc := range rejected {
		err := validateSidecarEnv(tc.env)
		if err == nil || !errors.Is(err, validate.ErrForbidden) {
			t.Fatalf("%s: expected ErrForbidden, got %v", tc.name, err)
		}
	}
}

// TestEnsureSidecarDirRejectsSymlinkedRoot covers the rename-TOCTOU hardening:
// when the socket ROOT itself is a symlink, the fd-anchored open (O_NOFOLLOW)
// must refuse it instead of creating the per-server tree inside the symlink
// target. The previous path-based implementation followed the intermediate
// symlink silently.
func TestEnsureSidecarDirRejectsSymlinkedRoot(t *testing.T) {
	realRoot := t.TempDir()
	parent := t.TempDir()
	symRoot := filepath.Join(parent, "root")
	if err := os.Symlink(realRoot, symRoot); err != nil {
		t.Fatalf("plant symlinked root: %v", err)
	}
	d := &DockerRunner{SocketRoot: symRoot}
	if err := d.ensureSidecarDir("0196f0a2-1111-2222-3333-444444444444"); err == nil {
		t.Fatal("expected error when the socket root is a symlink")
	}
}

func TestRunRNSquadJS(t *testing.T) {
	root := t.TempDir()
	f := &Fake{Stdout: []byte("rns-container-id\n")}
	d := NewDocker(f)
	d.SocketRoot = root
	spec := RNSquadJSRunSpec{
		ServerID: "0196f0a2-1111-2222-3333-444444444444",
		Env:      map[string]string{"PANEL_BRIDGE_MODE": "shadow"},
	}
	// config.json is rendered by the API into the (root-owned) server dir
	// before the sidecar is launched; create it so RunRNSquadJS proceeds.
	serverDir := filepath.Join(root, spec.ServerID)
	if err := os.MkdirAll(serverDir, 0o750); err != nil {
		t.Fatalf("mkdir server dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(serverDir, "config.json"), []byte("{}"), 0o640); err != nil {
		t.Fatalf("write config.json: %v", err)
	}
	wantArgs, err := d.composeRNSquadJSArgs(spec)
	if err != nil {
		t.Fatalf("composeRNSquadJSArgs: %v", err)
	}
	id, err := d.RunRNSquadJS(context.Background(), spec)
	if err != nil {
		t.Fatalf("RunRNSquadJS: %v", err)
	}
	if id != "rns-container-id" {
		t.Errorf("id = %q, want rns-container-id", id)
	}
	if len(f.Calls) != 1 {
		t.Fatalf("expected 1 docker call, got %d", len(f.Calls))
	}
	if !reflect.DeepEqual(f.Calls[0].Args, wantArgs) {
		t.Fatalf("docker called with\n  %v\nwant\n  %v", f.Calls[0].Args, wantArgs)
	}
	// The server dir stays root-owned and is NOT sidecar-writable: 0o750 +
	// setgid, holding the host-authored config.json out of reach of uid 1001.
	parentInfo, err := os.Stat(serverDir)
	if err != nil {
		t.Fatalf("stat server dir: %v", err)
	}
	if parentInfo.Mode().Perm() != 0o750 {
		t.Errorf("server dir perm = %o, want 750", parentInfo.Mode().Perm())
	}
	if parentInfo.Mode()&os.ModeSetgid == 0 {
		t.Errorf("server dir missing setgid bit: mode %v", parentInfo.Mode())
	}
	// The sock subdir is the ONLY thing the sidecar (uid 1001) can write,
	// with mode 02770 so the panel group keeps rwx + setgid and others get
	// nothing. This is where the sidecar creates rcon.sock.
	sockInfo, err := os.Stat(filepath.Join(serverDir, "sock"))
	if err != nil {
		t.Fatalf("stat sock dir: %v", err)
	}
	if sockInfo.Mode().Perm() != 0o770 {
		t.Errorf("sock dir perm = %o, want 770", sockInfo.Mode().Perm())
	}
	if sockInfo.Mode()&os.ModeSetgid == 0 {
		t.Errorf("sock dir missing setgid bit: mode %v", sockInfo.Mode())
	}
}

// TestEnsureSidecarDirRejectsSymlink covers Fix 3: a planted symlink at the
// per-server dir would otherwise redirect root's chmod/chown to an
// attacker-chosen target. ensureSidecarDir must refuse it with a forbidden
// error (ErrForbidden lives in package validate).
func TestEnsureSidecarDirRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	target := t.TempDir()
	serverID := "0196f0a2-1111-2222-3333-444444444444"
	if err := os.Symlink(target, filepath.Join(root, serverID)); err != nil {
		t.Fatalf("plant symlink: %v", err)
	}
	d := &DockerRunner{SocketRoot: root}
	err := d.ensureSidecarDir(serverID)
	if err == nil || !errors.Is(err, validate.ErrForbidden) {
		t.Fatalf("expected ErrForbidden for symlinked server dir, got %v", err)
	}
}

// TestRunRNSquadJSRequiresRenderedConfig covers Fix 5: if config.json is
// absent, docker (root) would silently create a DIRECTORY at the :ro bind
// source. RunRNSquadJS must abort before invoking docker when config.json is
// missing or not a regular file.
func TestRunRNSquadJSRequiresRenderedConfig(t *testing.T) {
	root := t.TempDir()
	f := &Fake{Stdout: []byte("should-not-run\n")}
	d := NewDocker(f)
	d.SocketRoot = root
	spec := RNSquadJSRunSpec{
		ServerID: "0196f0a2-1111-2222-3333-444444444444",
		Env:      map[string]string{"PANEL_BRIDGE_MODE": "shadow"},
	}
	if _, err := d.RunRNSquadJS(context.Background(), spec); err == nil {
		t.Fatal("expected error when config.json is not rendered")
	}
	if len(f.Calls) != 0 {
		t.Fatalf("docker must NOT be invoked without config.json, got %d calls", len(f.Calls))
	}

	// A directory at config.json (not a regular file) must also be rejected.
	if err := os.MkdirAll(filepath.Join(root, spec.ServerID, "config.json"), 0o750); err != nil {
		t.Fatalf("mkdir fake config dir: %v", err)
	}
	if _, err := d.RunRNSquadJS(context.Background(), spec); err == nil {
		t.Fatal("expected error when config.json is a directory")
	}
	if len(f.Calls) != 0 {
		t.Fatalf("docker must NOT be invoked for non-regular config.json, got %d calls", len(f.Calls))
	}
}

// TestEnsureSidecarDirSetsModeAndToleratesNonRootChown documents the non-root
// contract: the bridge runs as root in production where the Chown to uid 1001
// succeeds. Under a non-root test process the Chown returns EPERM, which
// ensureSidecarDir tolerates (a non-root bridge cannot drive containers
// anyway); the dir and its 02770 mode must still be set so the assertion is on
// the directory state, not the Chown error.
func TestEnsureSidecarDirSetsModeAndToleratesNonRootChown(t *testing.T) {
	root := t.TempDir()
	d := &DockerRunner{SocketRoot: root}
	serverID := "0196f0a2-1111-2222-3333-444444444444"
	if err := d.ensureSidecarDir(serverID); err != nil {
		t.Fatalf("ensureSidecarDir: %v", err)
	}
	serverDir := filepath.Join(root, serverID)
	serverInfo, err := os.Stat(serverDir)
	if err != nil {
		t.Fatalf("stat server dir: %v", err)
	}
	// Server dir: 0o750 + setgid, root-owned (no chown), config.json safe.
	if serverInfo.Mode().Perm() != 0o750 || serverInfo.Mode()&os.ModeSetgid == 0 {
		t.Fatalf("server dir mode = %v, want drwxr-s--- (02750)", serverInfo.Mode())
	}
	// Sock subdir: 0o770 + setgid, the only sidecar-writable level.
	sockInfo, err := os.Stat(filepath.Join(serverDir, "sock"))
	if err != nil {
		t.Fatalf("stat sock dir: %v", err)
	}
	if sockInfo.Mode().Perm() != 0o770 || sockInfo.Mode()&os.ModeSetgid == 0 {
		t.Fatalf("sock dir mode = %v, want drwxrws--- (02770)", sockInfo.Mode())
	}
}
