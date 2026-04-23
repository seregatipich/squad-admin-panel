package validate

import (
	"errors"
	"testing"
)

func TestPathRejectsRelative(t *testing.T) {
	_, err := Path("relative/path", PanelDataRoot)
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("expected ErrForbidden for relative, got %v", err)
	}
}

func TestPathRejectsTraversal(t *testing.T) {
	_, err := Path("/var/lib/squad-panel/../../etc/passwd", PanelDataRoot)
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("expected ErrForbidden for traversal, got %v", err)
	}
}

func TestPathRejectsNullByte(t *testing.T) {
	_, err := Path("/var/lib/squad-panel/abc\x00/file", PanelDataRoot)
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("expected ErrForbidden for null byte, got %v", err)
	}
}

func TestPathAcceptsUnderRoot(t *testing.T) {
	good := "/var/lib/squad-panel/configs/abcdef01-0000-1111-2222-333344445555/ServerConfig/Rcon.cfg"
	got, err := Path(good, PanelDataRoot)
	if err != nil {
		t.Fatalf("Path rejected good: %v", err)
	}
	if got != good {
		t.Errorf("Path mutated input: got %q want %q", got, good)
	}
}
