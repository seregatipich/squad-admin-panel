package fsx

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// Regression tests for #32 (finding #418): configs/{uuid}/ServerConfig and
// saved/{uuid} are bind-mounted read-write into the game container, so any
// entry inside them may be a planted symlink or FIFO. The root-owned bridge
// must never follow one out of its trust root when it writes or chmods.

const outsideContent = "host-file-must-stay-untouched\n"

type writeFunc struct {
	name string
	call func(p string, content []byte, mode os.FileMode) error
}

var writeFuncs = []writeFunc{
	{"Write", Write},
	{"AtomicWrite", AtomicWrite},
}

// scratchServerBase registers a temp dir as both a writable root and a
// server-scoped base (the test stand-in for /var/lib/squad-panel/configs) and
// returns the base plus the per-server directory
// <base>/00000000-0000-4000-8000-000000000001.
func scratchServerBase(t *testing.T) (base, serverDir string) {
	t.Helper()
	base = t.TempDir()
	origRoots, origBases := writableRoots, serverScopedBases
	writableRoots = append([]string{base}, writableRoots...)
	serverScopedBases = append([]string{base}, serverScopedBases...)
	t.Cleanup(func() { writableRoots, serverScopedBases = origRoots, origBases })
	serverDir = filepath.Join(base, "00000000-0000-4000-8000-000000000001")
	if err := os.MkdirAll(filepath.Join(serverDir, "ServerConfig"), 0o755); err != nil {
		t.Fatalf("mkdir server dir: %v", err)
	}
	return base, serverDir
}

// outsideFile creates a 0600 file outside every writable root.
func outsideFile(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "shadow")
	if err := os.WriteFile(p, []byte(outsideContent), 0o600); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	return p
}

func assertOutsideUntouched(t *testing.T, p string) {
	t.Helper()
	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read outside file: %v", err)
	}
	if string(got) != outsideContent {
		t.Fatalf("outside file was overwritten through a symlink: %q", got)
	}
	info, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat outside file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("outside file was chmodded through a symlink to %o", perm)
	}
}

func TestWrite_DoesNotFollowLeafSymlinkOutOfServerRoot(t *testing.T) {
	for _, fn := range writeFuncs {
		t.Run(fn.name, func(t *testing.T) {
			_, serverDir := scratchServerBase(t)
			target := outsideFile(t)
			cfg := filepath.Join(serverDir, "ServerConfig", "Server.cfg")
			if err := os.Symlink(target, cfg); err != nil {
				t.Fatalf("symlink: %v", err)
			}
			err := fn.call(cfg, []byte("attacker-controlled"), 0o644)
			assertOutsideUntouched(t, target)
			if fn.name == "Write" && err == nil {
				t.Fatalf("Write through an escaping symlink succeeded")
			}
			if fn.name == "AtomicWrite" && err == nil {
				// The rename must have replaced the link itself, not its target.
				info, lerr := os.Lstat(cfg)
				if lerr != nil || !info.Mode().IsRegular() {
					t.Fatalf("AtomicWrite left %s as %v (err %v), want a regular file", cfg, info, lerr)
				}
			}
		})
	}
}

func TestWrite_DoesNotFollowSymlinkedDirectoryOutOfServerRoot(t *testing.T) {
	for _, fn := range writeFuncs {
		t.Run(fn.name, func(t *testing.T) {
			_, serverDir := scratchServerBase(t)
			outsideDir := t.TempDir()
			if err := os.Chmod(outsideDir, 0o700); err != nil {
				t.Fatalf("chmod outside dir: %v", err)
			}
			link := filepath.Join(serverDir, "ServerConfig", "sub")
			if err := os.Symlink(outsideDir, link); err != nil {
				t.Fatalf("symlink: %v", err)
			}
			if err := fn.call(filepath.Join(link, "Server.cfg"), []byte("x"), 0o644); err == nil {
				t.Fatalf("%s through a symlinked directory succeeded", fn.name)
			}
			if _, err := os.Lstat(filepath.Join(outsideDir, "Server.cfg")); err == nil {
				t.Fatalf("%s created a file outside the server root", fn.name)
			}
			info, err := os.Stat(outsideDir)
			if err != nil {
				t.Fatalf("stat outside dir: %v", err)
			}
			if perm := info.Mode().Perm(); perm != 0o700 {
				t.Fatalf("%s chmodded the outside directory to %o", fn.name, perm)
			}
		})
	}
}

// A symlink from one server's configs into a sibling server's directory stays
// under the shared base but crosses the per-server trust boundary.
func TestWrite_DoesNotFollowSymlinkIntoSiblingServer(t *testing.T) {
	for _, fn := range writeFuncs {
		t.Run(fn.name, func(t *testing.T) {
			base, serverDir := scratchServerBase(t)
			sibling := filepath.Join(base, "00000000-0000-4000-8000-000000000002")
			if err := os.MkdirAll(sibling, 0o755); err != nil {
				t.Fatalf("mkdir sibling: %v", err)
			}
			siblingFile := filepath.Join(sibling, "Admins.cfg")
			if err := os.WriteFile(siblingFile, []byte(outsideContent), 0o600); err != nil {
				t.Fatalf("write sibling file: %v", err)
			}
			cfg := filepath.Join(serverDir, "ServerConfig", "Admins.cfg")
			if err := os.Symlink(siblingFile, cfg); err != nil {
				t.Fatalf("symlink: %v", err)
			}
			_ = fn.call(cfg, []byte("attacker-controlled"), 0o644)
			assertOutsideUntouched(t, siblingFile)
		})
	}
}

func TestWrite_RejectsFIFOWithoutBlocking(t *testing.T) {
	_, serverDir := scratchServerBase(t)
	fifo := filepath.Join(serverDir, "ServerConfig", "Server.cfg")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- Write(fifo, []byte("x"), 0o644) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatalf("Write to a FIFO succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("Write blocked on a FIFO planted in the server root")
	}
}

func TestWrite_FollowsSymlinkThatStaysInsideServerRoot(t *testing.T) {
	for _, fn := range writeFuncs {
		t.Run(fn.name, func(t *testing.T) {
			_, serverDir := scratchServerBase(t)
			real := filepath.Join(serverDir, "ServerConfig", "real")
			if err := os.MkdirAll(real, 0o755); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
			if err := os.Symlink("real", filepath.Join(serverDir, "ServerConfig", "alias")); err != nil {
				t.Fatalf("symlink: %v", err)
			}
			p := filepath.Join(serverDir, "ServerConfig", "alias", "Server.cfg")
			if err := fn.call(p, []byte("ok"), 0o644); err != nil {
				t.Fatalf("%s inside the server root: %v", fn.name, err)
			}
			got, err := os.ReadFile(filepath.Join(real, "Server.cfg"))
			if err != nil || string(got) != "ok" {
				t.Fatalf("read back: %q, %v", got, err)
			}
		})
	}
}

func TestWrite_OverwritesExistingRegularFile(t *testing.T) {
	for _, fn := range writeFuncs {
		t.Run(fn.name, func(t *testing.T) {
			_, serverDir := scratchServerBase(t)
			p := filepath.Join(serverDir, "ServerConfig", "Server.cfg")
			if err := os.WriteFile(p, []byte("a much longer previous content"), 0o600); err != nil {
				t.Fatalf("seed: %v", err)
			}
			if err := fn.call(p, []byte("new"), 0o644); err != nil {
				t.Fatalf("%s: %v", fn.name, err)
			}
			got, err := os.ReadFile(p)
			if err != nil || string(got) != "new" {
				t.Fatalf("read back: %q, %v", got, err)
			}
			info, err := os.Stat(p)
			if err != nil || info.Mode().Perm() != 0o644 {
				t.Fatalf("mode after %s: %v, %v", fn.name, info, err)
			}
		})
	}
}

func TestWrite_RejectsServerDirectoryItself(t *testing.T) {
	for _, fn := range writeFuncs {
		t.Run(fn.name, func(t *testing.T) {
			_, serverDir := scratchServerBase(t)
			if err := fn.call(serverDir, []byte("x"), 0o644); err == nil {
				t.Fatalf("%s accepted the per-server directory itself", fn.name)
			}
		})
	}
}

func TestWriteTrustRoot_ScopesDotDotPrefixedNameToItsOwnDirectory(t *testing.T) {
	base, _ := scratchServerBase(t)
	root, rel, err := writeTrustRoot(filepath.Join(base, "..evil", "Server.cfg"))
	if err != nil {
		t.Fatalf("writeTrustRoot: %v", err)
	}
	if root != filepath.Join(base, "..evil") || rel != "Server.cfg" {
		t.Fatalf("got root %q rel %q, want the ..evil directory as its own trust root", root, rel)
	}
}
