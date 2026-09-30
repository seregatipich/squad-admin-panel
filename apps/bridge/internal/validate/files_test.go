package validate

import (
	"errors"
	"os"
	"testing"
)

// Regression for #74 (findings #395/#404/#1245): the caller-supplied mode of
// file_atomic_write was applied verbatim by root, so a compromised API could
// make Admins.cfg/Rcon.cfg world-writable (0o666) or set setuid/setgid/sticky
// bits. Only the known-safe modes are accepted.
func TestWritableFileMode(t *testing.T) {
	if got, err := WritableFileMode(0); err != nil || got != 0o644 {
		t.Fatalf("WritableFileMode(0) = %o, %v; want 0644 default", got, err)
	}
	for _, good := range []uint32{0o644, 0o640, 0o600} {
		got, err := WritableFileMode(good)
		if err != nil || got != os.FileMode(good) {
			t.Errorf("WritableFileMode(%o) = %o, %v; want allowed", good, got, err)
		}
	}
	for _, bad := range []uint32{
		0o666, 0o777, 0o755, 0o646, 0o400, 0o4644, 0o2644, 0o1644,
		uint32(os.ModeSetuid) | 0o644, uint32(os.ModeSetgid) | 0o644, uint32(os.ModeSticky) | 0o644,
	} {
		if _, err := WritableFileMode(bad); !errors.Is(err, ErrForbidden) {
			t.Errorf("WritableFileMode(%#o) should be rejected with ErrForbidden, got %v", bad, err)
		}
	}
}
