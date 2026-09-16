package fsx

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/validate"
)

func TestReadRejectsOutsideRoots(t *testing.T) {
	_, err := Read("/etc/passwd")
	if err == nil {
		t.Fatal("expected error reading /etc/passwd")
	}
	if !errors.Is(err, validate.ErrForbidden) {
		t.Errorf("expected ErrForbidden, got %v", err)
	}
}

func TestReadRejectsRelative(t *testing.T) {
	_, err := Read("relative/path")
	if !errors.Is(err, validate.ErrForbidden) {
		t.Errorf("expected ErrForbidden, got %v", err)
	}
}

func TestAtomicWriteRejectsPathOutsideRoot(t *testing.T) {
	err := AtomicWrite("/tmp/not-allowed.txt", []byte("nope"), 0o644)
	if !errors.Is(err, validate.ErrForbidden) {
		t.Errorf("expected ErrForbidden, got %v", err)
	}
}

func TestWriteRejectsRelative(t *testing.T) {
	err := Write("relative.txt", []byte(""), 0o644)
	if !errors.Is(err, validate.ErrForbidden) {
		t.Errorf("expected ErrForbidden, got %v", err)
	}
}

// Regression: panel-host-bridge.service runs with UMask=0077. Without an
// explicit chmod after os.WriteFile / O_CREAT, the files land at 0600
// which blocks Squad (uid 1001) from reading Rcon.cfg and prevents
// worker-rcon from ever connecting (ECONNREFUSED on port 21114). Write
// and AtomicWrite must force the requested mode.
func TestWriteForcesModePastUmask(t *testing.T) {
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
		{"Write", func(p string) error { return Write(p, []byte("hello"), 0o644) }},
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
