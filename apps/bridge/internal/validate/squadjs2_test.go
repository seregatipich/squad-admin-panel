package validate

import (
	"errors"
	"testing"
)

const sidecarTestUUID = "0196f0a2-1111-2222-3333-444444444444"

func TestContainerNameAcceptsSquadJS2Sidecar(t *testing.T) {
	if err := ContainerName("squadjs2-" + sidecarTestUUID); err != nil {
		t.Fatalf("squadjs2 sidecar name rejected: %v", err)
	}
	for _, name := range []string{
		"squadjs2-",
		"squadjs2-not-a-uuid",
		"squadjs2" + sidecarTestUUID,
		"squadjs2-" + sidecarTestUUID + "-extra",
		"xsquadjs2-" + sidecarTestUUID,
	} {
		if err := ContainerName(name); err == nil {
			t.Fatalf("expected %q to be rejected", name)
		}
	}
}

// The sidecar image must never be reachable through the generic container_run
// RPC: that path takes caller-supplied mounts and would bypass the sidecar
// hardening (read-only rootfs, uid 1001, config-only binds).
func TestSquadJS2ImageIsNotGenericallyRunnable(t *testing.T) {
	if err := ContainerImage(SquadJS2Image); err == nil {
		t.Fatal("SquadJS2Image must not be in the generic container_run allowlist")
	}
}

func TestSidecarServerRootAcceptsBothEngines(t *testing.T) {
	for _, root := range []string{PanelSocketRoot, PanelSquadJS2Root} {
		path := root + "/" + sidecarTestUUID
		cleaned, err := SidecarServerRoot(path)
		if err != nil {
			t.Fatalf("%s rejected: %v", path, err)
		}
		if cleaned != path {
			t.Fatalf("cleaned = %q, want %q", cleaned, path)
		}
	}
}

func TestSidecarServerRootRejectsEverythingElse(t *testing.T) {
	for _, path := range []string{
		"/run/squad-panel",
		"/run/squad-panel/squadjs2",
		"/run/squad-panel/squadjs2/" + sidecarTestUUID + "/config.json",
		"/run/squad-panel/squadjs2/" + sidecarTestUUID + "/../../../etc",
		"/run/squad-panel/other/" + sidecarTestUUID,
		"/etc",
		"/var/lib/squad-panel/saved/" + sidecarTestUUID,
		"relative/" + sidecarTestUUID,
	} {
		if _, err := SidecarServerRoot(path); err == nil {
			t.Fatalf("expected %q to be rejected", path)
		} else if !errors.Is(err, ErrForbidden) {
			t.Fatalf("%q rejected with %v, want ErrForbidden", path, err)
		}
	}
}
