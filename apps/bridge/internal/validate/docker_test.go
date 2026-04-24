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

func TestContainerImage_AllowsRNSquadJS(t *testing.T) {
	if err := ContainerImage(RNSquadJSImage); err != nil {
		t.Fatalf("expected RNSquadJSImage allowed, got %v", err)
	}
}

func TestContainerName_AllowsRNSquadJSSidecar(t *testing.T) {
	uuid := "019dbaa5-1234-7abc-8def-0123456789ab"
	if err := ContainerName("rnsquadjs-" + uuid); err != nil {
		t.Fatalf("expected rnsquadjs-<uuid> allowed, got %v", err)
	}
}

func TestContainerName_RejectsMalformedRNSquadJS(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"uppercase hex", "rnsquadjs-019DBAA5-1234-7abc-8def-0123456789ab"},
		{"empty uuid", "rnsquadjs-"},
		{"prefix probe", "xrnsquadjs-019dbaa5-1234-7abc-8def-0123456789ab"},
		{"missing dashes", "rnsquadjs-019dbaa512347abc8def0123456789ab"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if err := ContainerName(tc.in); err == nil {
				t.Fatalf("expected rejection for %q", tc.in)
			}
		})
	}
}
