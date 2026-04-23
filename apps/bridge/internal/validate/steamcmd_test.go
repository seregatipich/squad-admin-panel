package validate

import (
	"strings"
	"testing"
)

func goodArgs() []string {
	return []string{
		"+@sSteamCmdForcePlatformType", "linux",
		"+@ShutdownOnFailedCommand", "1",
		"+@NoPromptForPassword", "1",
		"+force_install_dir", // will join with the next token, so replace below
	}
}

func TestSteamCMDRequiresPlatformBeforeLogin(t *testing.T) {
	args := []string{
		"+login", "anonymous",
		"+@sSteamCmdForcePlatformType", "linux",
		"+force_install_dir", "/opt/squad-servers/abcdef01-0000-1111-2222-333344445555",
		"+app_update", "403240",
		"+quit",
	}
	if _, err := SteamCMDArgs(args); err == nil {
		t.Error("expected error for platform-after-login ordering")
	}
}

func TestSteamCMDHappyPath(t *testing.T) {
	args := []string{
		"+@sSteamCmdForcePlatformType", "linux",
		"+@ShutdownOnFailedCommand", "1",
		"+@NoPromptForPassword", "1",
		"+force_install_dir", "/opt/squad-servers/abcdef01-0000-1111-2222-333344445555",
		"+login", "anonymous",
		"+app_update", "403240", "validate",
		"+quit",
	}
	// force_install_dir test token needs to be joined form
	args = []string{
		"+@sSteamCmdForcePlatformType", "linux",
		"+@ShutdownOnFailedCommand", "1",
		"+@NoPromptForPassword", "1",
		"+force_install_dir /opt/squad-servers/abcdef01-0000-1111-2222-333344445555",
		"+login", "anonymous",
		"+app_update", "403240", "validate",
		"+quit",
	}
	if _, err := SteamCMDArgs(args); err != nil {
		t.Fatalf("unexpected error on happy path: %v", err)
	}
}

func TestSteamCMDRejectsLoginWithPassword(t *testing.T) {
	args := []string{
		"+@sSteamCmdForcePlatformType", "linux",
		"+force_install_dir /opt/squad-servers/abcdef01-0000-1111-2222-333344445555",
		"+login", "admin123", "supersecret",
		"+app_update", "403240",
		"+quit",
	}
	_, err := SteamCMDArgs(args)
	if err == nil {
		t.Error("login with password should be rejected (not on token whitelist)")
	}
}

func TestSteamCMDRejectsInstallDirOutsideOptSquadServers(t *testing.T) {
	args := []string{
		"+@sSteamCmdForcePlatformType", "linux",
		"+force_install_dir /tmp/anywhere",
		"+login", "anonymous",
		"+app_update", "403240",
		"+quit",
	}
	_, err := SteamCMDArgs(args)
	if err == nil {
		t.Error("install-dir outside /opt/squad-servers should be rejected")
	}
}

func TestSteamCMDRejectsAppUpdateOtherAppIDs(t *testing.T) {
	args := []string{
		"+@sSteamCmdForcePlatformType", "linux",
		"+force_install_dir /opt/squad-servers/abcdef01-0000-1111-2222-333344445555",
		"+login", "anonymous",
		"+app_update", "1234567", // not 403240
		"+quit",
	}
	_, err := SteamCMDArgs(args)
	if err == nil || !strings.Contains(err.Error(), "not in steamcmd whitelist") {
		t.Errorf("foreign app id should be rejected: %v", err)
	}
}

func TestSteamCMDEmpty(t *testing.T) {
	if _, err := SteamCMDArgs(nil); err == nil {
		t.Error("nil args must be rejected")
	}
	if _, err := SteamCMDArgs([]string{}); err == nil {
		t.Error("empty args must be rejected")
	}
}
