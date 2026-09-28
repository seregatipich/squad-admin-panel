// Package fsx implements the whitelisted file operations. Every
// function here re-validates its paths (belt-and-braces: callers should
// pass already-validated paths from validate.Path but we double-check).
package fsx

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/validate"
)

// MaxReadBytes caps a single file_read response and a single file write.
const MaxReadBytes = 10 << 20

// DefaultDepotHostPath is the fallback location for the squad-depot
// volume's contents on disk when the PANEL_DEPOT_HOST_PATH env var is
// not set. For a Docker-managed named volume this is always valid; for
// a bind-mounted squad-depot the operator must set PANEL_DEPOT_HOST_PATH
// to the bind-mount source (e.g. ${DATA_DIR}/depot) because Docker does
// not populate the /var/lib/docker/volumes/squad-depot/_data stub for
// bind-mounted volumes — reads through the stub get ENOENT.
const DefaultDepotHostPath = "/var/lib/docker/volumes/squad-depot"

// DepotHostPath resolves the squad-depot volume's on-disk location,
// honoring PANEL_DEPOT_HOST_PATH at process start. The result is an
// absolute, filepath.Clean'd path that can be used as a readableRoot.
func DepotHostPath() string {
	if v := os.Getenv("PANEL_DEPOT_HOST_PATH"); v != "" {
		return filepath.Clean(v)
	}
	return DefaultDepotHostPath
}

// Roots the bridge may write to. The depot volume is intentionally
// omitted so the bridge cannot mutate game binaries. Reads are validated
// and confined in handlers (readableTrustRoot), not here.
var writableRoots = []string{
	validate.PanelDataRoot,
}

// mkdirAllWithMode is like os.MkdirAll but re-applies `perm` to every
// directory it created. os.MkdirAll honours the process umask when
// creating directories, and the panel-host-bridge systemd unit runs
// with UMask=0077 — which would otherwise leave configs/{uuid}/ at 0700
// so Squad (uid 1001) cannot read the .cfg files bind-mounted into its
// container.
//
// Directories that already existed are never touched: the installer
// deliberately keeps configs/ and saved/ at 0750 because the files
// inside (Rcon.cfg with the plaintext RCON password) are 0644, so
// widening an existing ancestor would expose them to every local user.
func mkdirAllWithMode(p string, perm os.FileMode) error {
	// Collect the missing segments, deepest first, up to the nearest
	// existing ancestor.
	var created []string
	for cur := filepath.Clean(p); ; {
		if _, err := os.Lstat(cur); err == nil {
			break
		}
		created = append(created, cur)
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	if err := os.MkdirAll(p, perm); err != nil {
		return err
	}
	// Chmod from the shallowest created segment down so each level is
	// traversable before its child is adjusted.
	for i := len(created) - 1; i >= 0; i-- {
		if err := os.Chmod(created[i], perm); err != nil {
			return fmt.Errorf("chmod %s: %w", created[i], err)
		}
	}
	return nil
}

// Write writes content atomically-ish (no rename); creates parent dirs
// up through the allowed root as needed. A trailing os.Chmod bypasses
// the process umask so Squad (uid 1001) can read what the bridge (root,
// UMask=0077) writes.
func Write(p string, content []byte, mode os.FileMode) error {
	_, err := validate.Path(p, writableRoots...)
	if err != nil {
		return err
	}
	if err := mkdirAllWithMode(filepath.Dir(p), 0o755); err != nil {
		return fmt.Errorf("mkdir parent: %w", err)
	}
	if len(content) > MaxReadBytes {
		return fmt.Errorf("%w: content exceeds %d-byte cap", validate.ErrForbidden, MaxReadBytes)
	}
	if err := os.WriteFile(p, content, mode); err != nil {
		return err
	}
	return os.Chmod(p, mode)
}

// AtomicWrite replaces p with content via a unique temp file in the same
// directory, fsync and rename, so readers see either the old or the new
// file and concurrent writers of one path never corrupt each other (the
// last rename wins). Parent directories are created as in Write; the
// final file gets `mode` regardless of the process umask.
func AtomicWrite(p string, content []byte, mode os.FileMode) error {
	_, err := validate.Path(p, writableRoots...)
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := mkdirAllWithMode(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir parent: %w", err)
	}
	if len(content) > MaxReadBytes {
		return fmt.Errorf("%w: content exceeds %d-byte cap", validate.ErrForbidden, MaxReadBytes)
	}

	// A unique temp file per call (O_EXCL inside CreateTemp): with a fixed
	// name, concurrent writers of the same config would share one inode
	// through separate fds and interleave their bytes before the rename.
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(p)+".*.tmp")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	// CreateTemp makes the file 0600; apply the requested mode explicitly.
	if err := os.Chmod(tmpPath, mode); err != nil {
		return fmt.Errorf("chmod temp: %w", err)
	}

	// Atomic rename: tmp -> final. Existing file (if any) is overwritten
	// atomically on POSIX; no .bak needed because the previous version
	// is preserved by config_versions / role_squad_permissions snapshots.
	if err := os.Rename(tmpPath, p); err != nil {
		return fmt.Errorf("rename into place: %w", err)
	}
	committed = true

	// fsync the parent directory so the rename survives a power loss
	// (POSIX requires the directory entry change to be flushed in a
	// separate fsync from the file's data fsync).
	dirF, err := os.Open(dir)
	if err != nil {
		// Non-fatal — the rename committed; we just couldn't fsync the
		// directory. Worth logging but not failing the request.
		return nil
	}
	defer func() { _ = dirF.Close() }()
	if err := dirF.Sync(); err != nil {
		// Best-effort; on filesystems where directory fsync is a no-op
		// this can return EINVAL. Don't fail the request.
		_ = err
	}
	return nil
}
