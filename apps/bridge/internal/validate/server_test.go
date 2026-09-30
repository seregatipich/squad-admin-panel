package validate

import (
	"errors"
	"testing"
)

const testServerID = "019dbb45-3556-751f-9124-d4cf0e6b0053"

func TestServerConfigsMount(t *testing.T) {
	want := PanelConfigsRoot + "/" + testServerID + "/ServerConfig"
	for _, good := range []string{want, want + "/", PanelConfigsRoot + "//" + testServerID + "/ServerConfig"} {
		got, err := ServerConfigsMount(good, testServerID)
		if err != nil || got != want {
			t.Errorf("ServerConfigsMount(%q) = %q, %v; want %q", good, got, err, want)
		}
	}
	for _, bad := range []string{
		PanelConfigsRoot + "/019dbb45-0000-751f-9124-d4cf0e6b0099/ServerConfig",
		PanelConfigsRoot + "/" + testServerID,
		want + "/Nested",
		want + "/../../" + testServerID + "x/ServerConfig",
		"/etc",
	} {
		if _, err := ServerConfigsMount(bad, testServerID); !errors.Is(err, ErrForbidden) {
			t.Errorf("ServerConfigsMount(%q) should be forbidden, got %v", bad, err)
		}
	}
}

func TestServerSavedMount(t *testing.T) {
	want := PanelSavedRoot + "/" + testServerID
	if got, err := ServerSavedMount(want, testServerID); err != nil || got != want {
		t.Fatalf("ServerSavedMount = %q, %v", got, err)
	}
	for _, bad := range []string{
		PanelSavedRoot + "/019dbb45-0000-751f-9124-d4cf0e6b0099",
		want + "/SquadGame",
		PanelSavedRoot,
	} {
		if _, err := ServerSavedMount(bad, testServerID); !errors.Is(err, ErrForbidden) {
			t.Errorf("ServerSavedMount(%q) should be forbidden, got %v", bad, err)
		}
	}
}

func TestServerPort(t *testing.T) {
	for _, good := range []int{1024, 7787, 65535} {
		if err := ServerPort(good); err != nil {
			t.Errorf("port %d should be allowed: %v", good, err)
		}
	}
	for _, bad := range []int{-1, 0, 22, 1023, 65536, 70000} {
		if err := ServerPort(bad); !errors.Is(err, ErrForbidden) {
			t.Errorf("port %d should be forbidden, got %v", bad, err)
		}
	}
}
