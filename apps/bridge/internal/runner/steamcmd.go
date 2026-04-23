package runner

import (
	"context"
	"errors"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

// SteamCMD wraps a Runner and serialises the streaming interface the
// bridge exposes via RPC.
type SteamCMD struct {
	R Runner
	// Binary path (defaults to /usr/games/steamcmd on Debian/Ubuntu).
	Binary string
}

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
	exit, err := s.R.Stream(ctx, bin, args, nil, onStdout, onStderr)
	if err != nil {
		return exit, err
	}
	if exit != 0 {
		return exit, errors.New("steamcmd exited non-zero")
	}
	return exit, nil
}
