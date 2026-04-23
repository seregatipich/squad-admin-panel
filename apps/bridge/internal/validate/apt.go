package validate

import (
	"fmt"
	"regexp"
)

// AllowedAptPackages mirrors packages/shared-config/src/bridge-methods.ts.
// Keep this list in sync (CI enforces via the shared-config-go.test.ts
// parity check when the fixture is set up).
var AllowedAptPackages = map[string]struct{}{
	"lib32gcc-s1":         {},
	"lib32stdc++6":        {},
	"libc6-i386":          {},
	"libsdl2-2.0-0:i386":  {},
	"curl":                {},
	"wget":                {},
	"ca-certificates":     {},
	"tar":                 {},
	"locales":             {},
	"file":                {},
	"bsdmainutils":        {},
	"python3":             {},
	"tmux":                {},
	"screen":              {},
}

// aptNameRegex matches a Debian package spec. We allow an optional
// ":arch" suffix to support multi-arch packages (lib32 i386 spec).
var aptNameRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9+\-.]{0,62}(?::[a-z0-9][a-z0-9]{0,15})?$`)

// AptPackage rejects anything outside the whitelist or anything that
// doesn't parse as a package name.
func AptPackage(name string) error {
	if !aptNameRegex.MatchString(name) {
		return fmt.Errorf("%w: package name %q fails syntax check", ErrForbidden, name)
	}
	if _, ok := AllowedAptPackages[name]; !ok {
		return fmt.Errorf("%w: package %q not in whitelist", ErrForbidden, name)
	}
	return nil
}

// AptPackageList validates every entry or fails on the first bad one.
func AptPackageList(list []string) error {
	if len(list) == 0 {
		return fmt.Errorf("%w: empty package list", ErrInvalidArgs)
	}
	seen := map[string]struct{}{}
	for _, p := range list {
		if _, dup := seen[p]; dup {
			return fmt.Errorf("%w: duplicate package %q", ErrInvalidArgs, p)
		}
		seen[p] = struct{}{}
		if err := AptPackage(p); err != nil {
			return err
		}
	}
	return nil
}
