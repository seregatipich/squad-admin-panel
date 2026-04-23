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

// Roots we allow *reading* from. DepotVolumeRoot is where Docker stores
// the squad-depot volume's contents on disk — we mount it read-only into
// server containers, and the install flow reads default .cfg files from
// it to seed a new server's configs/{uuid}/ServerConfig/ directory.
var readableRoots = []string{
	validate.PanelDataRoot,
	"/var/lib/docker/volumes/squad-depot",
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

// Write writes content atomically-ish (no rename); creates parent dirs
// up through the allowed root as needed.
func Write(p string, content []byte, mode os.FileMode) error {
	_, err := validate.Path(p, writableRoots...)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return fmt.Errorf("mkdir parent: %w", err)
	}
	if len(content) > MaxReadBytes {
		return fmt.Errorf("%w: content exceeds %d-byte cap", validate.ErrForbidden, MaxReadBytes)
	}
	return os.WriteFile(p, content, mode)
}

func AtomicWrite(p string, content []byte, mode os.FileMode) error {
	_, err := validate.Path(p, writableRoots...)
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o755); err != nil {
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

	if _, err := os.Stat(p); err == nil {
		_ = os.Rename(p, p+".bak")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("stat existing: %w", err)
	}

	if err := os.Rename(newPath, p); err != nil {
		return fmt.Errorf("rename into place: %w", err)
	}
	return nil
}
