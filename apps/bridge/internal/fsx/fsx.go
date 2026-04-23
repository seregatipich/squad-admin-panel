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

// MaxReadBytes caps a single file_read. 10 MiB leaves headroom for
// growing Squad logs while staying bounded.
const MaxReadBytes = 10 << 20

// Read returns the contents of p, subject to validation. Only files
// under the allowed roots may be read.
func Read(p string) ([]byte, error) {
	_, err := validate.Path(p, validate.PanelDataRoot, "/opt/squad-servers")
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

// Write writes content to p with the given mode, after validating the path.
// Parent directories must already exist (we do not mkdir -p).
func Write(p string, content []byte, mode os.FileMode) error {
	_, err := validate.Path(p, validate.PanelDataRoot, "/opt/squad-servers")
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Dir(p)); err != nil {
		return fmt.Errorf("parent dir: %w", err)
	}
	if len(content) > MaxReadBytes {
		return fmt.Errorf("%w: content exceeds %d-byte cap", validate.ErrForbidden, MaxReadBytes)
	}
	return os.WriteFile(p, content, mode)
}

// AtomicWrite writes to a sibling ".new" file then renames. On
// success, the previous contents are preserved in ".bak".
// This matches what the TZ §2.1 bridge whitelist promises.
func AtomicWrite(p string, content []byte, mode os.FileMode) error {
	_, err := validate.Path(p, validate.PanelDataRoot, "/opt/squad-servers")
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if _, err := os.Stat(dir); err != nil {
		return fmt.Errorf("parent dir: %w", err)
	}
	if len(content) > MaxReadBytes {
		return fmt.Errorf("%w: content exceeds %d-byte cap", validate.ErrForbidden, MaxReadBytes)
	}

	// Write to .new
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

	// Backup existing, if any
	if _, err := os.Stat(p); err == nil {
		_ = os.Rename(p, p+".bak")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("stat existing: %w", err)
	}

	// Rename .new -> p
	if err := os.Rename(newPath, p); err != nil {
		return fmt.Errorf("rename into place: %w", err)
	}
	return nil
}
