package fsx

import (
	"errors"
	"testing"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
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
