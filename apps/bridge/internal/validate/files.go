package validate

import (
	"fmt"
	"os"
)

// DefaultWritableFileMode is applied when a file_atomic_write caller does not
// pin a mode: owner rw, group/other read, so Squad (uid 1001) can read the
// .cfg files the root-owned bridge writes.
const DefaultWritableFileMode os.FileMode = 0o644

// allowedWritableFileModes is the exhaustive set of modes the bridge (root)
// will apply to a file it writes. Nothing group/other-writable, executable,
// or carrying setuid/setgid/sticky bits is ever accepted: the ServerConfig
// directory is bind-mounted into the game container, so a world-writable
// Admins.cfg or Rcon.cfg would let the game process rewrite them.
var allowedWritableFileModes = map[os.FileMode]struct{}{
	0o644: {},
	0o640: {},
	0o600: {},
}

// WritableFileMode maps a caller-supplied raw mode to the os.FileMode the
// bridge applies. 0 selects DefaultWritableFileMode; any value outside
// allowedWritableFileModes (including os.ModeSetuid/ModeSetgid/ModeSticky and
// the classic 0o4000/0o2000/0o1000 bits) is rejected with ErrForbidden.
func WritableFileMode(raw uint32) (os.FileMode, error) {
	if raw == 0 {
		return DefaultWritableFileMode, nil
	}
	mode := os.FileMode(raw)
	if _, ok := allowedWritableFileModes[mode]; !ok {
		return 0, fmt.Errorf("%w: file mode %#o not in allowlist {0644, 0640, 0600}", ErrForbidden, raw)
	}
	return mode, nil
}
