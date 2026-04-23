package runner

import (
	"context"
	"errors"
	"os/exec"
	"os/user"
	"regexp"
	"strconv"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

// SteamCMD wraps a Runner and serialises the streaming interface the
// bridge exposes via RPC.
type SteamCMD struct {
	R Runner
	// Binary path (defaults to /usr/games/steamcmd on Debian/Ubuntu).
	Binary string
}

var installDirCapture = regexp.MustCompile(
	`^\+force_install_dir (/opt/squad-servers/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/?)$`,
)

// Stream runs steamcmd with validated args, calling onStdout/onStderr
// as data arrives. The arg list must have already passed
// validate.SteamCMDArgs; we validate again defensively.
func (s *SteamCMD) Stream(
	ctx context.Context,
	args []string,
	onStdout, onStderr func([]byte),
) (int, error) {
	if _, err := validate.SteamCMDArgs(args); err != nil {
		return 0, err
	}
	bin := s.Binary
	if bin == "" {
		bin = "/usr/games/steamcmd"
	}
	var installDir string
	for _, a := range args {
		if m := installDirCapture.FindStringSubmatch(a); len(m) == 2 {
			installDir = m[1]
			break
		}
	}
	home := installDir
	if home != "" && home[len(home)-1] == '/' {
		home = home[:len(home)-1]
	}
	// Spawn steamcmd via systemd-run with --scope so it runs outside
	// the bridge's strict SystemCallFilter / ProtectHome sandbox
	// (steamcmd:i386 uses legacy socketcall/ipc syscalls that
	// @system-service rejects) and is reparented to a transient scope.
	// --uid/--gid drop to the 'squad' user so the install tree stays
	// owned by an unprivileged account.
	runArgs := []string{
		"--pipe", "--wait", "--quiet", "--collect",
		"--uid=squad",
		"--gid=squad",
	}
	if home != "" {
		runArgs = append(runArgs, "--setenv=HOME="+home)
	}
	runArgs = append(runArgs, "--setenv=LC_ALL=C.UTF-8")
	runArgs = append(runArgs, "--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	runArgs = append(runArgs, "--")
	runArgs = append(runArgs, bin)
	runArgs = append(runArgs, args...)
	exit, err := s.R.Stream(ctx, "/usr/bin/systemd-run", runArgs, nil, onStdout, onStderr)
	if err != nil {
		return exit, err
	}
	if exit != 0 {
		return exit, errors.New("steamcmd exited non-zero")
	}
	if installDir != "" {
		if u, lookupErr := user.Lookup("squad"); lookupErr == nil {
			uid, _ := strconv.Atoi(u.Uid)
			gid, _ := strconv.Atoi(u.Gid)
			if uid > 0 && gid > 0 {
				if chownErr := exec.CommandContext(ctx, "chown", "-R",
					u.Uid+":"+u.Gid, installDir).Run(); chownErr != nil {
					onStderr([]byte("warning: chown " + installDir + " failed: " + chownErr.Error() + "\n"))
				}
			}
		}
	}
	return exit, nil
}
