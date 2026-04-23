// Package validate contains whitelist-based validators for every
// privileged argument the bridge accepts. Every mutating method in
// cmd/panel-host-bridge consults one of these before touching the host.
package validate

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// ErrForbidden is returned when an argument is rejected by policy.
var ErrForbidden = errors.New("forbidden")

// Path enforces:
//   - absolute (never relative / traversal)
//   - clean (no . or .. segments after Clean)
//   - lives under a permitted root
func Path(p string, allowedRoots ...string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("%w: empty path", ErrForbidden)
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("%w: non-absolute path %q", ErrForbidden, p)
	}
	cleaned := filepath.Clean(p)
	if strings.Contains(cleaned, "\x00") {
		return "", fmt.Errorf("%w: null byte in path", ErrForbidden)
	}
	for _, root := range allowedRoots {
		root = filepath.Clean(root)
		if cleaned == root || strings.HasPrefix(cleaned, root+string(filepath.Separator)) {
			return cleaned, nil
		}
	}
	return "", fmt.Errorf("%w: path %q outside allowed roots %v", ErrForbidden, cleaned, allowedRoots)
}

var uuidRegexp = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func uuidLike(s string) bool {
	return uuidRegexp.MatchString(s)
}
