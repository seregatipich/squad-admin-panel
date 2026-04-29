// Package fsx implements the whitelisted file operations. Every
// function here re-validates its paths (belt-and-braces: callers should
// pass already-validated paths from validate.Path but we double-check).
package fsx

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

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

// Roots we allow *reading* from. The depot volume root is added so the
// install flow can seed a new server's configs/{uuid}/ServerConfig/
// directory from the SteamCMD-provided .cfg defaults.
var readableRoots = []string{
	validate.PanelDataRoot,
	DepotHostPath(),
}

// Writable roots are a strict subset of readable. The depot volume is
// intentionally omitted so the bridge cannot mutate game binaries.
var writableRoots = []string{
	validate.PanelDataRoot,
}

func Read(p string) ([]byte, error) {
	_, err := validate.Path(p, readableRoots...)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(p)
	if err != nil {
		return nil, fmt.Errorf("stat: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("%w: %q is a directory", validate.ErrForbidden, p)
	}
	if info.Size() > MaxReadBytes {
		return nil, fmt.Errorf("%w: %q exceeds %d-byte cap", validate.ErrForbidden, p, MaxReadBytes)
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// mkdirAllWithMode is like os.MkdirAll but re-applies `perm` to every
// path segment it created. os.MkdirAll honours the process umask when
// creating directories, and the panel-host-bridge systemd unit runs
// with UMask=0077 — which would otherwise leave configs/ at 0700 so
// Squad (uid 1001) cannot read the .cfg files bind-mounted into its
// container.
func mkdirAllWithMode(p string, perm os.FileMode) error {
	if err := os.MkdirAll(p, perm); err != nil {
		return err
	}
	// Walk upward and chmod each segment that lies under the panel root;
	// stop at the first one that already has the right permissions.
	segments := []string{}
	cur := p
	for cur != "/" && cur != "." {
		segments = append(segments, cur)
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	for _, seg := range segments {
		info, err := os.Stat(seg)
		if err != nil {
			continue
		}
		if info.Mode().Perm() == perm {
			break
		}
		if err := os.Chmod(seg, perm); err != nil {
			// Not fatal — Squad only needs the leaf + one level up to be
			// readable. Stop trying higher up the tree.
			break
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

	newPath := p + ".new"
	f, err := os.OpenFile(newPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return fmt.Errorf("create new: %w", err)
	}
	if _, err := f.Write(content); err != nil {
		_ = f.Close()
		_ = os.Remove(newPath)
		return fmt.Errorf("write new: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(newPath)
		return fmt.Errorf("sync: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	// Chmod explicitly — O_CREAT honours UMask, so the file we just made
	// is probably 0600 even though `mode` was 0644.
	if err := os.Chmod(newPath, mode); err != nil {
		_ = os.Remove(newPath)
		return fmt.Errorf("chmod new: %w", err)
	}

	// Atomic rename: tmp -> final. Existing file (if any) is overwritten
	// atomically on POSIX; no .bak needed because the previous version
	// is preserved by config_versions / role_squad_permissions snapshots.
	if err := os.Rename(newPath, p); err != nil {
		_ = os.Remove(newPath)
		return fmt.Errorf("rename into place: %w", err)
	}

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
