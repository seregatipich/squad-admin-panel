package runner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/validate"
)

// Regression for #74 (finding #411): container_run only checked that the
// mount paths started with *some* UUID under the panel roots, then passed the
// raw strings to `-v`. A compromised API could mount another server's configs
// or saved tree (or a nested subdirectory) into squad-<id>, and ports,
// MULTIHOME and extra args reached the game server unchecked.
func TestDockerRunRejectsOutOfPolicySpecs(t *testing.T) {
	const otherID = "019dbb45-0000-751f-9124-d4cf0e6b0099"
	cases := map[string]func(*ContainerRunSpec){
		"configs of another server": func(s *ContainerRunSpec) {
			s.ConfigsHost = "/var/lib/squad-panel/configs/" + otherID + "/ServerConfig"
		},
		"saved of another server": func(s *ContainerRunSpec) {
			s.SavedHost = "/var/lib/squad-panel/saved/" + otherID
		},
		"configs root instead of ServerConfig": func(s *ContainerRunSpec) {
			s.ConfigsHost = "/var/lib/squad-panel/configs/" + s.ServerID
		},
		"nested saved subdirectory": func(s *ContainerRunSpec) {
			s.SavedHost = "/var/lib/squad-panel/saved/" + s.ServerID + "/SquadGame"
		},
		"game port zero":       func(s *ContainerRunSpec) { s.GamePort = 0 },
		"query port negative":  func(s *ContainerRunSpec) { s.QueryPort = -1 },
		"beacon port too high": func(s *ContainerRunSpec) { s.BeaconPort = 70000 },
		"privileged rcon port": func(s *ContainerRunSpec) { s.RCONPort = 22 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			f := &Fake{}
			spec := validRunSpec()
			mutate(&spec)
			if _, err := NewDocker(f).Run(context.Background(), spec); !errors.Is(err, validate.ErrForbidden) {
				t.Fatalf("expected ErrForbidden, got %v", err)
			}
			if len(f.Calls) != 0 {
				t.Fatalf("docker must not be invoked, got %d calls", len(f.Calls))
			}
		})
	}
}

// The bridge never forwards free-form extra launch arguments, and a multihome
// that is not a bare IP literal (which would smuggle launch flags) is refused.
func TestDockerRunRejectsMultihomeThatIsNotAnIP(t *testing.T) {
	f := &Fake{}
	spec := validRunSpec()
	spec.Multihome = "0.0.0.0 -ExecCmds=quit"
	if _, err := NewDocker(f).Run(context.Background(), spec); !errors.Is(err, validate.ErrInvalidArgs) {
		t.Fatalf("expected ErrInvalidArgs, got %v", err)
	}
	if len(f.Calls) != 0 {
		t.Fatalf("docker must not be invoked, got %d calls", len(f.Calls))
	}
}

func TestDockerRunAcceptsIPv6Multihome(t *testing.T) {
	f := &Fake{Stdout: []byte("id\n")}
	spec := validRunSpec()
	spec.Multihome = "2001:db8::1"
	if _, err := NewDocker(f).Run(context.Background(), spec); err != nil {
		t.Fatalf("Run: %v", err)
	}
	args := strings.Join(f.Calls[0].Args, " ")
	for _, want := range []string{"MULTIHOME=2001:db8::1"} {
		if !strings.Contains(args, want) {
			t.Errorf("args missing %q: %s", want, args)
		}
	}
}

// The `-v` sources must be the validated, cleaned paths, never the raw
// caller strings.
func TestDockerRunMountsCleanedPaths(t *testing.T) {
	f := &Fake{Stdout: []byte("id\n")}
	spec := validRunSpec()
	spec.ConfigsHost = "/var/lib/squad-panel/configs/" + spec.ServerID + "/ServerConfig/"
	spec.SavedHost = "/var/lib/squad-panel//saved/" + spec.ServerID
	if _, err := NewDocker(f).Run(context.Background(), spec); err != nil {
		t.Fatalf("Run: %v", err)
	}
	args := f.Calls[0].Args
	want := []string{
		"/var/lib/squad-panel/configs/" + spec.ServerID + "/ServerConfig:/squad/SquadGame/ServerConfig:rw",
		"/var/lib/squad-panel/saved/" + spec.ServerID + ":/squad/SquadGame/Saved:rw",
	}
	for _, w := range want {
		found := false
		for _, a := range args {
			if a == w {
				found = true
			}
		}
		if !found {
			t.Errorf("missing cleaned mount %q in %v", w, args)
		}
	}
}

// Regression for #74 (finding #415): both containers ran with Docker's
// default capability set (incl. NET_RAW) on the host network and could gain
// privileges through setuid binaries.
func TestDockerRunDropsCapabilities(t *testing.T) {
	f := &Fake{Stdout: []byte("id\n")}
	if _, err := NewDocker(f).Run(context.Background(), validRunSpec()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	args := strings.Join(f.Calls[0].Args, " ")
	for _, want := range []string{
		"--cap-drop ALL",
		"--cap-add CHOWN",
		"--cap-add DAC_OVERRIDE",
		"--cap-add FOWNER",
		"--cap-add SETUID",
		"--cap-add SETGID",
		"--cap-add KILL",
		"--security-opt no-new-privileges",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("squad-server args missing %q: %s", want, args)
		}
	}
	if strings.Contains(args, "NET_RAW") || strings.Contains(args, "NET_ADMIN") {
		t.Errorf("squad-server must not keep network capabilities: %s", args)
	}
}

func TestComposeRNSquadJSArgsDropsAllCapabilities(t *testing.T) {
	args, err := (&DockerRunner{}).composeRNSquadJSArgs(RNSquadJSRunSpec{ServerID: "0196f0a2-1111-2222-3333-444444444444"})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 512"} {
		if !strings.Contains(joined, want) {
			t.Errorf("sidecar args missing %q: %s", want, joined)
		}
	}
	if strings.Contains(joined, "--cap-add") {
		t.Errorf("the sidecar needs no capabilities: %s", joined)
	}
}

// sidecarFixture prepares temp socket/saved roots with a rendered config.json
// so RunRNSquadJS reaches the Logs verification.
func sidecarFixture(t *testing.T) (*DockerRunner, *Fake, RNSquadJSRunSpec, string) {
	t.Helper()
	f := &Fake{Stdout: []byte("rns\n")}
	d := NewDocker(f)
	d.SocketRoot = t.TempDir()
	d.SavedRoot = t.TempDir()
	spec := RNSquadJSRunSpec{ServerID: "0196f0a2-1111-2222-3333-444444444444"}
	serverDir := filepath.Join(d.SocketRoot, spec.ServerID)
	if err := os.MkdirAll(serverDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(serverDir, "config.json"), []byte("{}"), 0o640); err != nil {
		t.Fatal(err)
	}
	return d, f, spec, filepath.Join(d.SavedRoot, spec.ServerID)
}

// Regression for #74 (finding #412): the sidecar's Logs bind source lives in
// the Saved tree the game server (uid 1001) owns. A symlink planted at Logs
// or any parent component would make root's docker bind an arbitrary host
// directory into the sidecar. Every component must be a real directory.
func TestRunRNSquadJSRejectsSymlinkedLogsPath(t *testing.T) {
	for _, planted := range []string{"Logs"} {
		t.Run(planted, func(t *testing.T) {
			d, f, spec, savedDir := sidecarFixture(t)
			link := filepath.Join(savedDir, planted)
			if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(t.TempDir(), link); err != nil {
				t.Fatal(err)
			}
			if _, err := d.RunRNSquadJS(context.Background(), spec); !errors.Is(err, validate.ErrForbidden) {
				t.Fatalf("expected ErrForbidden, got %v", err)
			}
			if len(f.Calls) != 0 {
				t.Fatalf("docker must not run with a symlinked Logs path, got %d calls", len(f.Calls))
			}
		})
	}
}

// Regression for #100: the game container writes /squad/SquadGame/Saved/Logs,
// where saved/{uuid} is mounted at /squad/SquadGame/Saved, so on the host the
// logs are saved/{uuid}/Logs. The sidecar must bind exactly that directory, not
// a directory one SquadGame/Saved level deeper that Squad never writes to.
func TestSidecarLogsBindIsWhereTheGameContainerWritesLogs(t *testing.T) {
	d, f, spec, savedDir := sidecarFixture(t)
	d.SavedRoot = filepath.Dir(savedDir)
	game := validRunSpec()
	game.ServerID = spec.ServerID
	game.SavedHost = "/var/lib/squad-panel/saved/" + spec.ServerID
	game.ConfigsHost = "/var/lib/squad-panel/configs/" + spec.ServerID + "/ServerConfig"
	gameFake := &Fake{Stdout: []byte("id\n")}
	if _, err := NewDocker(gameFake).Run(context.Background(), game); err != nil {
		t.Fatalf("Run: %v", err)
	}
	var savedSource string
	for _, a := range gameFake.Calls[0].Args {
		if src, ok := strings.CutSuffix(a, ":/squad/SquadGame/Saved:rw"); ok {
			savedSource = src
		}
	}
	if savedSource == "" {
		t.Fatalf("game container has no Saved mount: %v", gameFake.Calls[0].Args)
	}
	if _, err := d.RunRNSquadJS(context.Background(), spec); err != nil {
		t.Fatalf("RunRNSquadJS: %v", err)
	}
	// Squad's /squad/SquadGame/Saved/Logs is <saved mount source>/Logs on the host.
	want := filepath.Join(filepath.Dir(savedDir), spec.ServerID, "Logs") + ":/squad/Logs:ro"
	if filepath.Base(savedSource) != spec.ServerID {
		t.Fatalf("saved mount source %q is not saved/{uuid}", savedSource)
	}
	if !strings.Contains(strings.Join(f.Calls[0].Args, " "), want) {
		t.Fatalf("sidecar logs bind %q is not the game container's Saved/Logs; args %v", want, f.Calls[0].Args)
	}
}

// A missing Logs tree is created as real directories (instead of letting
// docker create it root-owned through whatever the path resolves to), and
// the bind points at it.
func TestRunRNSquadJSCreatesMissingLogsDir(t *testing.T) {
	d, f, spec, savedDir := sidecarFixture(t)
	if _, err := d.RunRNSquadJS(context.Background(), spec); err != nil {
		t.Fatalf("RunRNSquadJS: %v", err)
	}
	logs := filepath.Join(savedDir, "Logs")
	if info, err := os.Lstat(logs); err != nil || !info.IsDir() {
		t.Fatalf("Logs dir not created as a real directory: %v %v", info, err)
	}
	want := logs + ":/squad/Logs:ro"
	if !strings.Contains(strings.Join(f.Calls[0].Args, " "), want) {
		t.Fatalf("logs bind %q missing from %v", want, f.Calls[0].Args)
	}
}
