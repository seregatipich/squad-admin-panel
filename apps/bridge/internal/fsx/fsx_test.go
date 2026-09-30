package fsx

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/validate"
)

func TestAtomicWriteRejectsPathOutsideRoot(t *testing.T) {
	err := AtomicWrite("/tmp/not-allowed.txt", []byte("nope"), 0o644)
	if !errors.Is(err, validate.ErrForbidden) {
		t.Errorf("expected ErrForbidden, got %v", err)
	}
}

func TestAtomicWriteRejectsRelative(t *testing.T) {
	err := AtomicWrite("relative.txt", []byte(""), 0o644)
	if !errors.Is(err, validate.ErrForbidden) {
		t.Errorf("expected ErrForbidden, got %v", err)
	}
}

// Regression: panel-host-bridge.service runs with UMask=0077. Without an
// explicit chmod after O_CREAT, the files land at 0600 which blocks
// Squad (uid 1001) from reading Rcon.cfg and prevents worker-rcon from
// ever connecting (ECONNREFUSED on port 21114). AtomicWrite must force
// the requested mode.
func TestAtomicWriteForcesModePastUmask(t *testing.T) {
	scratchRoot := t.TempDir()
	// Register scratchRoot as a writable root so validate.Path passes in
	// this unit-test context (production uses /var/lib/squad-panel).
	orig := writableRoots
	writableRoots = append([]string{scratchRoot}, writableRoots...)
	t.Cleanup(func() { writableRoots = orig })

	old := syscall.Umask(0o077)
	t.Cleanup(func() { syscall.Umask(old) })

	for _, fn := range []struct {
		name string
		call func(p string) error
	}{
		{"AtomicWrite", func(p string) error { return AtomicWrite(p, []byte("hello"), 0o644) }},
	} {
		fn := fn
		t.Run(fn.name, func(t *testing.T) {
			p := filepath.Join(scratchRoot, "nested", "dir", "conf.cfg")
			if err := fn.call(p); err != nil {
				t.Fatalf("%s: %v", fn.name, err)
			}
			info, err := os.Stat(p)
			if err != nil {
				t.Fatalf("stat: %v", err)
			}
			if got := info.Mode().Perm(); got != 0o644 {
				t.Errorf("%s produced mode %o, want 0644 (umask was 0077)", fn.name, got)
			}
			dirInfo, err := os.Stat(filepath.Dir(p))
			if err != nil {
				t.Fatalf("stat dir: %v", err)
			}
			if got := dirInfo.Mode().Perm(); got != 0o755 {
				t.Errorf("%s produced dir mode %o, want 0755 (umask was 0077)", fn.name, got)
			}
		})
	}
}

func TestDepotHostPath_DefaultWhenUnset(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "")
	if got := DepotHostPath(); got != DefaultDepotHostPath {
		t.Errorf("expected fallback %q, got %q", DefaultDepotHostPath, got)
	}
}

func TestDepotHostPath_HonorsEnvOverride(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "/home/squad/squad-admin-panel/data/depot")
	if got, want := DepotHostPath(), "/home/squad/squad-admin-panel/data/depot"; got != want {
		t.Errorf("expected %q, got %q", want, got)
	}
}

func TestDepotHostPath_CleansTrailingSlash(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "/opt/depot/")
	if got, want := DepotHostPath(), "/opt/depot"; got != want {
		t.Errorf("expected %q, got %q", want, got)
	}
}

// scratchWritableRoot registers a temp dir as a writable root for the test.
func scratchWritableRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	orig := writableRoots
	writableRoots = append([]string{root}, writableRoots...)
	t.Cleanup(func() { writableRoots = orig })
	return root
}

// Regression for #45 (finding #390): the installer sets configs/ and saved/
// to 0750 because the .cfg files inside (Rcon.cfg holds the RCON password in
// plaintext) are 0644. Creating a new server's configs/{uuid}/ServerConfig
// tree must chmod only the directories it created, never widen an existing
// ancestor to 0755.
func TestAtomicWritePreservesExistingAncestorMode(t *testing.T) {
	root := scratchWritableRoot(t)
	old := syscall.Umask(0o077)
	t.Cleanup(func() { syscall.Umask(old) })

	for _, fn := range []struct {
		name string
		call func(p string) error
	}{
		{"AtomicWrite", func(p string) error { return AtomicWrite(p, []byte("x"), 0o644) }},
	} {
		t.Run(fn.name, func(t *testing.T) {
			configs := filepath.Join(root, fn.name, "configs")
			if err := os.MkdirAll(configs, 0o750); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
			if err := os.Chmod(configs, 0o750); err != nil {
				t.Fatalf("chmod: %v", err)
			}
			p := filepath.Join(configs, "uuid", "ServerConfig", "Rcon.cfg")
			if err := fn.call(p); err != nil {
				t.Fatalf("%s: %v", fn.name, err)
			}
			info, err := os.Stat(configs)
			if err != nil {
				t.Fatalf("stat: %v", err)
			}
			if got := info.Mode().Perm(); got != 0o750 {
				t.Errorf("existing ancestor widened to %o, want 0750", got)
			}
			for _, created := range []string{filepath.Join(configs, "uuid"), filepath.Join(configs, "uuid", "ServerConfig")} {
				info, err := os.Stat(created)
				if err != nil {
					t.Fatalf("stat: %v", err)
				}
				if got := info.Mode().Perm(); got != 0o755 {
					t.Errorf("created dir %s has mode %o, want 0755", created, got)
				}
			}
		})
	}
}

// Regression for #45 (finding #391): concurrent AtomicWrite calls on the same
// path must never leave a file that mixes their contents. With the fixed
// p+".new" temp name, every writer shared one inode through its own fd and
// interleaved writes (a long body, then a short body overwriting its head)
// produced a corrupt config.
func TestAtomicWriteConcurrentWritersNeverInterleave(t *testing.T) {
	root := scratchWritableRoot(t)
	p := filepath.Join(root, "Bans.cfg")
	bodies := [][]byte{
		bytes.Repeat([]byte("A"), 256<<10),
		bytes.Repeat([]byte("B"), 1<<10),
		bytes.Repeat([]byte("C"), 64<<10),
	}
	for round := 0; round < 50; round++ {
		var wg sync.WaitGroup
		for w := 0; w < 12; w++ {
			body := bodies[w%len(bodies)]
			wg.Add(1)
			go func() {
				defer wg.Done()
				_ = AtomicWrite(p, body, 0o644)
			}()
		}
		wg.Wait()
		got, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		matched := false
		for _, b := range bodies {
			if bytes.Equal(got, b) {
				matched = true
			}
		}
		if !matched {
			t.Fatalf("round %d: file (%d bytes) matches none of the written bodies", round, len(got))
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 1 {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("temp files left behind: %v", names)
	}
}
