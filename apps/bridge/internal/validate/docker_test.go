package validate

import (
	"errors"
	"testing"
)

func TestContainerName(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"squad-019dbb45-3556-751f-9124-d4cf0e6b0053", true},
		{"squad-depot-init-20260423204500", true},
		{"squad-019dbb45-3556-751f-9124", false},
		{"squad-abc", false},
		{"nginx", false},
		{"", false},
		{"squad-019dbb45-3556-751f-9124-d4cf0e6b005Z", false},
	}
	for _, c := range cases {
		err := ContainerName(c.name)
		if c.want && err != nil {
			t.Errorf("ContainerName(%q) = %v, want ok", c.name, err)
		}
		if !c.want && err == nil {
			t.Errorf("ContainerName(%q) = ok, want error", c.name)
		}
	}
}

func TestContainerImage(t *testing.T) {
	if err := ContainerImage("squad-server:latest"); err != nil {
		t.Errorf("expected squad-server:latest ok, got %v", err)
	}
	if err := ContainerImage("alpine:latest"); err == nil || !errors.Is(err, ErrForbidden) {
		t.Errorf("expected forbidden for alpine:latest, got %v", err)
	}
}

func TestResticSnapshotID(t *testing.T) {
	ok := []string{
		"latest",
		"a1b2c3d4", // short id
		"a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", // 64-char full id
	}
	for _, id := range ok {
		if err := ResticSnapshotID(id); err != nil {
			t.Errorf("ResticSnapshotID(%q) = %v, want ok", id, err)
		}
	}
	bad := []string{
		"",
		"LATEST",
		"A1B2C3D4",             // uppercase hex not allowed
		"a1b2c3d",              // 7 chars
		"a1b2c3d4e",            // 9 chars (between short and full)
		"a1b2c3d4; rm -rf /",   // injection attempt
		"latest --target /etc", // arg smuggling
		"$(whoami)",            // command substitution
		"a1b2c3d4\n",           // trailing newline
		"g1b2c3d4",             // non-hex char
	}
	for _, id := range bad {
		if err := ResticSnapshotID(id); err == nil {
			t.Errorf("ResticSnapshotID(%q) = ok, want error", id)
		} else if !errors.Is(err, ErrForbidden) {
			t.Errorf("ResticSnapshotID(%q) = %v, want ErrForbidden", id, err)
		}
	}
}

func TestPanelConfigFilePath(t *testing.T) {
	ok := "/var/lib/squad-panel/configs/019dbb45-3556-751f-9124-d4cf0e6b0053/ServerConfig/Server.cfg"
	if _, err := PanelConfigFilePath(ok); err != nil {
		t.Errorf("expected ok for %s, got %v", ok, err)
	}
	bad := []string{
		"/var/lib/squad-panel/configs/bad/ServerConfig/Server.cfg",
		"/var/lib/squad-panel/configs/019dbb45-3556-751f-9124-d4cf0e6b0053/Server.cfg",
		"/var/lib/squad-panel/configs/019dbb45-3556-751f-9124-d4cf0e6b0053/ServerConfig/../etc/passwd",
		"/var/lib/squad-panel/configs/019dbb45-3556-751f-9124-d4cf0e6b0053/ServerConfig/Unknown.cfg",
		"/etc/passwd",
	}
	for _, b := range bad {
		if _, err := PanelConfigFilePath(b); err == nil {
			t.Errorf("expected forbidden for %s, got ok", b)
		}
	}
}

func TestPanelSavedPath(t *testing.T) {
	if _, err := PanelSavedPath("/var/lib/squad-panel/saved/019dbb45-3556-751f-9124-d4cf0e6b0053/Logs/SquadGame.log"); err != nil {
		t.Errorf("expected ok: %v", err)
	}
	if _, err := PanelSavedPath("/var/lib/squad-panel/saved/not-a-uuid/x.log"); err == nil {
		t.Errorf("expected forbidden for non-uuid")
	}
}

func TestPanelConfigsServerRoot(t *testing.T) {
	uuid := "019dbb45-3556-751f-9124-d4cf0e6b0053"
	ok := "/var/lib/squad-panel/configs/" + uuid
	cleaned, err := PanelConfigsServerRoot(ok)
	if err != nil {
		t.Fatalf("expected ok for %q, got %v", ok, err)
	}
	if cleaned != ok {
		t.Errorf("cleaned = %q, want %q", cleaned, ok)
	}

	// Trailing-slash form should clean down to the same canonical path.
	cleaned, err = PanelConfigsServerRoot(ok + "/")
	if err != nil {
		t.Fatalf("expected ok for trailing slash, got %v", err)
	}
	if cleaned != ok {
		t.Errorf("trailing-slash cleaned = %q, want %q", cleaned, ok)
	}

	bad := []string{
		"",
		"configs/" + uuid,
		"/var/lib/squad-panel/configs/" + uuid + "/ServerConfig",
		"/var/lib/squad-panel/configs/" + uuid + "/ServerConfig/Server.cfg",
		"/var/lib/squad-panel/configs/not-a-uuid",
		"/var/lib/squad-panel/configs",
		"/var/lib/squad-panel/configs/../etc",
		"/var/lib/squad-panel/saved/" + uuid,
		"/etc/passwd",
		"/var/lib/squad-panel/configs/" + uuid + "\x00",
	}
	for _, b := range bad {
		if _, err := PanelConfigsServerRoot(b); err == nil {
			t.Errorf("expected forbidden for %q, got ok", b)
		} else if !errors.Is(err, ErrForbidden) {
			t.Errorf("expected ErrForbidden for %q, got %v", b, err)
		}
	}
}

func TestContainerNameAcceptsRnsquadjsSidecar(t *testing.T) {
	if err := ContainerName("rnsquadjs-0196f0a2-1111-2222-3333-444444444444"); err != nil {
		t.Fatalf("expected sidecar name to be allowed, got %v", err)
	}
}

func TestContainerNameRejectsRnsquadjsGarbage(t *testing.T) {
	for _, name := range []string{"rnsquadjs-", "rnsquadjs-notauuid", "rnsquadjs-0196f0a2-1111-2222-3333-44444444444Z", "rnsquadjs-0196F0A2-1111-2222-3333-444444444444"} {
		if err := ContainerName(name); err == nil {
			t.Fatalf("expected %q to be rejected", name)
		}
	}
}

func TestContainerImageRejectsRnsquadjs(t *testing.T) {
	if err := ContainerImage(RNSquadJSImage); err == nil || !errors.Is(err, ErrForbidden) {
		t.Fatalf("rnsquadjs image must NOT be launchable via generic container_run, got %v", err)
	}
}

func TestPanelSavedServerRoot(t *testing.T) {
	uuid := "019dbb45-3556-751f-9124-d4cf0e6b0053"
	ok := "/var/lib/squad-panel/saved/" + uuid
	cleaned, err := PanelSavedServerRoot(ok)
	if err != nil {
		t.Fatalf("expected ok for %q, got %v", ok, err)
	}
	if cleaned != ok {
		t.Errorf("cleaned = %q, want %q", cleaned, ok)
	}

	cleaned, err = PanelSavedServerRoot(ok + "/")
	if err != nil {
		t.Fatalf("expected ok for trailing slash, got %v", err)
	}
	if cleaned != ok {
		t.Errorf("trailing-slash cleaned = %q, want %q", cleaned, ok)
	}

	bad := []string{
		"",
		"saved/" + uuid,
		"/var/lib/squad-panel/saved/" + uuid + "/Logs",
		"/var/lib/squad-panel/saved/" + uuid + "/Logs/SquadGame.log",
		"/var/lib/squad-panel/saved/not-a-uuid",
		"/var/lib/squad-panel/saved",
		"/var/lib/squad-panel/saved/../etc",
		"/var/lib/squad-panel/configs/" + uuid,
		"/etc/passwd",
		"/var/lib/squad-panel/saved/" + uuid + "\x00",
	}
	for _, b := range bad {
		if _, err := PanelSavedServerRoot(b); err == nil {
			t.Errorf("expected forbidden for %q, got ok", b)
		} else if !errors.Is(err, ErrForbidden) {
			t.Errorf("expected ErrForbidden for %q, got %v", b, err)
		}
	}
}
