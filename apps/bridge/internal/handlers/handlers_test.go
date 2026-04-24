package handlers

import (
	"errors"
	"testing"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

func TestValidateReadablePath_AcceptsConfigsAndSaved(t *testing.T) {
	cases := []string{
		"/var/lib/squad-panel/configs/019dbaa5-1234-7abc-8def-0123456789ab/ServerConfig/Admins.cfg",
		"/var/lib/squad-panel/saved/019dbaa5-1234-7abc-8def-0123456789ab/SquadGame/Saved/Logs/SquadGame.log",
	}
	for _, p := range cases {
		if err := validateReadablePath(p); err != nil {
			t.Errorf("expected %q allowed, got %v", p, err)
		}
	}
}

func TestValidateReadablePath_DepotDefault(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "")
	if err := validateReadablePath("/var/lib/docker/volumes/squad-depot/SquadGame/ServerConfig/Admins.cfg"); err != nil {
		t.Errorf("expected default depot root allowed, got %v", err)
	}
}

func TestValidateReadablePath_DepotHonorsEnv(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "/opt/panel-data/depot")
	if err := validateReadablePath("/opt/panel-data/depot/SquadGame/ServerConfig/Admins.cfg"); err != nil {
		t.Errorf("expected env-override depot root allowed, got %v", err)
	}
}

func TestValidateReadablePath_RejectsOutsideRoots(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "/opt/panel-data/depot")
	cases := []string{
		"/etc/shadow",
		"/var/lib/squad-panel/../etc/passwd",
		"/opt/panel-data/depot/../../etc/shadow",
		"/home/squad/.ssh/authorized_keys",
	}
	for _, p := range cases {
		err := validateReadablePath(p)
		if err == nil {
			t.Errorf("expected rejection for %q", p)
			continue
		}
		if !errors.Is(err, validate.ErrForbidden) {
			t.Errorf("expected ErrForbidden for %q, got %v", p, err)
		}
	}
}

func TestValidateWritablePath_AcceptsConfigsOnly(t *testing.T) {
	ok := "/var/lib/squad-panel/configs/019dbaa5-1234-7abc-8def-0123456789ab/ServerConfig/Admins.cfg"
	if err := validateWritablePath(ok); err != nil {
		t.Errorf("expected %q writable, got %v", ok, err)
	}
}

func TestValidateWritablePath_RejectsDepot(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "/opt/panel-data/depot")
	bad := "/opt/panel-data/depot/SquadGame/ServerConfig/Admins.cfg"
	if err := validateWritablePath(bad); err == nil {
		t.Errorf("expected rejection for depot-write %q", bad)
	}
}
