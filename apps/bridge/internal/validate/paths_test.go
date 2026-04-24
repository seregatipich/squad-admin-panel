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

func TestPanelSocketPath_AllowsRoot(t *testing.T) {
	if _, err := PanelSocketPath("/run/squad-panel/rnsquadjs"); err != nil {
		t.Fatalf("expected sockets root allowed: %v", err)
	}
}

func TestPanelSocketPath_AllowsChild(t *testing.T) {
	if _, err := PanelSocketPath("/run/squad-panel/rnsquadjs/019dbaa5-1234-7abc-8def-0123456789ab.sock"); err != nil {
		t.Fatalf("expected child path allowed: %v", err)
	}
}

func TestPanelSocketPath_RejectsEscape(t *testing.T) {
	if _, err := PanelSocketPath("/run/squad-panel/rnsquadjs/../../etc/passwd"); err == nil {
		t.Fatal("expected rejection for escape")
	}
}
