// Package fsx implements the whitelisted file operations. Every
// function here re-validates its paths (belt-and-braces: callers should
// pass already-validated paths from validate.Path but we double-check)
// and then resolves them inside a trust root through an os.Root, so a
// symlink planted by the game container cannot redirect a root-owned
// write or chmod to a host file.
package fsx

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

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

// serverScopedBases are the writable bases whose {uuid} children are
// bind-mounted read-write into a game container. A write below one of them is
// confined to its own <base>/{uuid} directory: everything deeper may be a
// planted symlink, while the {uuid} directory (a mount source or its parent)
// cannot be replaced from inside the container. Tests override it.
var serverScopedBases = []string{validate.PanelConfigsRoot, validate.PanelSavedRoot}

// writeTrustRoot validates p against writableRoots and returns the directory
// its resolution must stay inside plus the path relative to it: <base>/{uuid}
// for a path under a server-scoped base, otherwise the matched writable root.
// The per-server directory itself is never a write target.
func writeTrustRoot(p string) (root, rel string, err error) {
	cleaned, err := validate.Path(p, writableRoots...)
	if err != nil {
		return "", "", err
	}
	for _, base := range serverScopedBases {
		relToBase, ok := relBelow(base, cleaned)
		if !ok {
			continue
		}
		serverID, rest, _ := strings.Cut(relToBase, string(filepath.Separator))
		if rest == "" {
			return "", "", fmt.Errorf("%w: %q is a server directory, not a file", validate.ErrForbidden, cleaned)
		}
		return filepath.Join(base, serverID), rest, nil
	}
	for _, wr := range writableRoots {
		wr = filepath.Clean(wr)
		if relToRoot, ok := relBelow(wr, cleaned); ok {
			return wr, relToRoot, nil
		}
	}
	return "", "", fmt.Errorf("%w: %q is a writable root, not a file", validate.ErrForbidden, cleaned)
}

// relBelow returns cleaned relative to dir when cleaned lies strictly below
// dir; a sibling whose name merely starts with ".." still counts as below.
func relBelow(dir, cleaned string) (string, bool) {
	rel, err := filepath.Rel(filepath.Clean(dir), cleaned)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return rel, true
}

// openWriteRoot validates p, creates its trust root (a host-owned directory
// the game container cannot reach) with mkdirAllWithMode, then creates the
// parent directories of rel inside the os.Root at 0755. Every step below the
// trust root resolves through the os.Root, so a symlink leading out of it
// fails the call instead of being followed. The caller closes the root.
func openWriteRoot(p string, content []byte) (*os.Root, string, error) {
	rootDir, rel, err := writeTrustRoot(p)
	if err != nil {
		return nil, "", err
	}
	if len(content) > MaxReadBytes {
		return nil, "", fmt.Errorf("%w: content exceeds %d-byte cap", validate.ErrForbidden, MaxReadBytes)
	}
	if err := mkdirAllWithMode(rootDir, 0o755); err != nil {
		return nil, "", fmt.Errorf("mkdir root: %w", err)
	}
	root, err := os.OpenRoot(rootDir)
	if err != nil {
		return nil, "", fmt.Errorf("open root: %w", err)
	}
	if err := mkdirAllInRoot(root, filepath.Dir(rel), 0o755); err != nil {
		_ = root.Close()
		return nil, "", fmt.Errorf("mkdir parent: %w", err)
	}
	return root, rel, nil
}

// mkdirAllInRoot is mkdirAllWithMode confined to root: it creates dir (a path
// relative to root) and re-applies perm to the segments it created, because
// the bridge's UMask=0077 would otherwise leave them at 0700. Segments that
// already existed are never touched (see mkdirAllWithMode).
func mkdirAllInRoot(root *os.Root, dir string, perm os.FileMode) error {
	if dir == "." {
		return nil
	}
	var created []string
	segment := ""
	for _, part := range strings.Split(dir, string(filepath.Separator)) {
		segment = filepath.Join(segment, part)
		if _, err := root.Lstat(segment); err == nil {
			continue
		}
		created = append(created, segment)
	}
	if err := root.MkdirAll(dir, perm); err != nil {
		return err
	}
	for _, seg := range created {
		if err := root.Chmod(seg, perm); err != nil {
			return err
		}
	}
	return nil
}

// requireRegular fails unless f is a regular file, so a FIFO, socket or
// device planted in an untrusted directory is refused.
func requireRegular(f *os.File, rel string) error {
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("%w: %q is not a regular file", validate.ErrForbidden, rel)
	}
	return nil
}

// Write replaces p's content in place (no rename), creating parent dirs as
// needed. The path is resolved inside its trust root (see writeTrustRoot), so
// neither the open nor the chmod can follow a symlink out of it; O_NONBLOCK
// keeps open(2) from hanging on a planted FIFO, and anything but a regular
// file is refused. The mode is applied with fchmod on the open descriptor to
// bypass the process umask so Squad (uid 1001) can read what the bridge
// (root, UMask=0077) writes.
func Write(p string, content []byte, mode os.FileMode) error {
	root, rel, err := openWriteRoot(p, content)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()

	f, err := root.OpenFile(rel, os.O_WRONLY|os.O_CREATE|syscall.O_NONBLOCK, mode)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	if err := requireRegular(f, rel); err != nil {
		return err
	}
	if err := f.Truncate(0); err != nil {
		return err
	}
	if _, err := f.Write(content); err != nil {
		return err
	}
	if err := f.Chmod(mode); err != nil {
		return err
	}
	return f.Close()
}

// AtomicWrite writes content to a sibling "<p>.new" file and renames it over
// p, so readers see either the old or the new content. Both files are
// resolved inside p's trust root (see writeTrustRoot): a stale or planted
// "<p>.new" is unlinked (never followed) and recreated with O_EXCL, and the
// rename replaces the directory entry for p even when it is a symlink, so the
// link's target is never written.
func AtomicWrite(p string, content []byte, mode os.FileMode) error {
	root, rel, err := openWriteRoot(p, content)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()

	// A unique temp name per call, created with O_EXCL inside the trust root:
	// with a fixed name, concurrent writers of one config would share an inode
	// through separate descriptors and interleave their bytes before the rename.
	// A planted file or symlink under a guessed name fails O_EXCL instead of
	// being followed.
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return fmt.Errorf("temp name: %w", err)
	}
	newRel := filepath.Join(filepath.Dir(rel), "."+filepath.Base(rel)+"."+hex.EncodeToString(suffix[:])+".tmp")
	f, err := root.OpenFile(newRel, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	if _, err := f.Write(content); err != nil {
		_ = f.Close()
		_ = root.Remove(newRel)
		return fmt.Errorf("write new: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = root.Remove(newRel)
		return fmt.Errorf("sync: %w", err)
	}
	// Chmod explicitly — O_CREAT honours UMask, so the file we just made
	// is probably 0600 even though `mode` was 0644.
	if err := f.Chmod(mode); err != nil {
		_ = f.Close()
		_ = root.Remove(newRel)
		return fmt.Errorf("chmod new: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = root.Remove(newRel)
		return fmt.Errorf("close: %w", err)
	}

	// Atomic rename: tmp -> final. Existing file (if any) is overwritten
	// atomically on POSIX; no .bak needed because the previous version
	// is preserved by config_versions / role_squad_permissions snapshots.
	if err := root.Rename(newRel, rel); err != nil {
		_ = root.Remove(newRel)
		return fmt.Errorf("rename into place: %w", err)
	}

	// fsync the parent directory so the rename survives a power loss
	// (POSIX requires the directory entry change to be flushed in a
	// separate fsync from the file's data fsync). Best-effort: the rename
	// already committed, and on filesystems where directory fsync is a
	// no-op this can return EINVAL.
	dirF, err := root.Open(filepath.Dir(rel))
	if err != nil {
		return nil
	}
	defer func() { _ = dirF.Close() }()
	_ = dirF.Sync()
	return nil
}
