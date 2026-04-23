package validate

import (
	"errors"
	"testing"
)

func TestUnitName(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{"squad-server-abcdef01-0000-1111-2222-333344445555.service", true},
		{"panel-host-bridge.service", true},
		{"squad-server-.service", false},
		{"squad-server-NOTUUID.service", false},
		{"nginx.service", false},
		{"../squad-server-abcdef01-0000-1111-2222-333344445555.service", false},
		{"squad-server-abcdef01-0000-1111-2222-333344445555.service\x00", false},
		{"", false},
	}
	for _, c := range cases {
		err := UnitName(c.name)
		gotOK := err == nil
		if gotOK != c.ok {
			t.Errorf("UnitName(%q) ok=%v want %v (err=%v)", c.name, gotOK, c.ok, err)
		}
	}
}

func TestAction(t *testing.T) {
	if err := Action("start"); err != nil {
		t.Errorf("start should be allowed: %v", err)
	}
	if err := Action("nuke"); err == nil {
		t.Error("nuke should be forbidden")
	}
}

func TestPathRejectsRelative(t *testing.T) {
	_, err := Path("relative/path", SquadInstallRoot)
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("expected ErrForbidden for relative, got %v", err)
	}
}

func TestPathRejectsTraversal(t *testing.T) {
	_, err := Path("/opt/squad-servers/../etc/passwd", SquadInstallRoot)
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("expected ErrForbidden for traversal, got %v", err)
	}
}

func TestPathRejectsNullByte(t *testing.T) {
	_, err := Path("/opt/squad-servers/abc\x00/file", SquadInstallRoot)
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("expected ErrForbidden for null byte, got %v", err)
	}
}

func TestSquadPathAcceptsUnderInstallRoot(t *testing.T) {
	good := "/opt/squad-servers/abcdef01-0000-1111-2222-333344445555/SquadGame/ServerConfig/Rcon.cfg"
	got, err := SquadPath(good)
	if err != nil {
		t.Fatalf("SquadPath rejected good path: %v", err)
	}
	if got != good {
		t.Errorf("SquadPath mutated path: got %q want %q", got, good)
	}
}

func TestSquadPathRejectsMissingUUID(t *testing.T) {
	_, err := SquadPath("/opt/squad-servers/just-a-dir/foo")
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("expected ErrForbidden for non-UUID segment, got %v", err)
	}
}

func TestSquadPathRejectsOutsideRoot(t *testing.T) {
	_, err := SquadPath("/etc/passwd")
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("expected ErrForbidden for outside root, got %v", err)
	}
}

func TestUnitPathOnlyAcceptsSquadOrBridgeUnits(t *testing.T) {
	goods := []string{
		"/etc/systemd/system/squad-server-abcdef01-0000-1111-2222-333344445555.service",
		"/etc/systemd/system/panel-host-bridge.service",
	}
	for _, g := range goods {
		if _, err := UnitPath(g); err != nil {
			t.Errorf("UnitPath(%q) unexpectedly rejected: %v", g, err)
		}
	}
	bads := []string{
		"/etc/systemd/system/nginx.service",
		"/etc/systemd/system/../passwd",
		"/tmp/fake-squad-server.service",
		"/etc/systemd/system/squad-server-SHORT.service",
	}
	for _, b := range bads {
		if _, err := UnitPath(b); err == nil {
			t.Errorf("UnitPath(%q) should have been rejected", b)
		}
	}
}

func TestEnvPathValidates(t *testing.T) {
	good := "/etc/squad-server/instance-abcdef01-0000-1111-2222-333344445555.env"
	if _, err := EnvPath(good); err != nil {
		t.Errorf("EnvPath rejected good: %v", err)
	}
	if _, err := EnvPath("/etc/squad-server/../something.env"); err == nil {
		t.Error("traversal should be rejected")
	}
	if _, err := EnvPath("/etc/squad-server/wrong.conf"); err == nil {
		t.Error("wrong suffix should be rejected")
	}
}
