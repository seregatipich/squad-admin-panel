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

// SquadInstallRoot is the only directory below which the bridge will
// allow steamcmd, file read/write, or symlink operations to land.
const SquadInstallRoot = "/opt/squad-servers"

// SystemdUnitDir is where we are allowed to write squad-server units.
const SystemdUnitDir = "/etc/systemd/system"

// Per-instance env files live under this dir.
const SquadEnvDir = "/etc/squad-server"

// SquadUnitRegex matches a panel-managed squad-server-*.service file.
var SquadUnitRegex = regexp.MustCompile(`^squad-server-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.service$`)

// BridgeUnit is the one non-squad unit we permit to touch — our own service.
const BridgeUnit = "panel-host-bridge.service"

// UnitName confirms a systemctl_* unit argument is legal.
// Allowed: any squad-server-{uuid}.service and panel-host-bridge.service.
func UnitName(name string) error {
	if name == BridgeUnit {
		return nil
	}
	if SquadUnitRegex.MatchString(name) {
		return nil
	}
	return fmt.Errorf("%w: unit %q does not match allowed pattern", ErrForbidden, name)
}

// SystemdAction lists every action we expose through systemctl_action.
var SystemdAction = map[string]struct{}{
	"start":   {},
	"stop":    {},
	"restart": {},
	"status":  {},
	"enable":  {},
	"disable": {},
}

// Action validates a systemctl_action verb.
func Action(a string) error {
	if _, ok := SystemdAction[a]; !ok {
		return fmt.Errorf("%w: action %q not in whitelist", ErrForbidden, a)
	}
	return nil
}

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

// SquadPath validates that p refers to something under /opt/squad-servers/{uuid}/.
func SquadPath(p string) (string, error) {
	cleaned, err := Path(p, SquadInstallRoot)
	if err != nil {
		return "", err
	}
	// Require a UUID segment after the root.
	rel, err := filepath.Rel(SquadInstallRoot, cleaned)
	if err != nil {
		return "", fmt.Errorf("%w: cannot derive relative path", ErrForbidden)
	}
	parts := strings.SplitN(rel, string(filepath.Separator), 2)
	if len(parts) == 0 || parts[0] == "" {
		return "", fmt.Errorf("%w: missing server UUID segment", ErrForbidden)
	}
	if !uuidLike(parts[0]) {
		return "", fmt.Errorf("%w: UUID segment %q is not a UUID", ErrForbidden, parts[0])
	}
	return cleaned, nil
}

// UnitPath validates that p is a squad-server unit file under /etc/systemd/system/.
func UnitPath(p string) (string, error) {
	cleaned, err := Path(p, SystemdUnitDir)
	if err != nil {
		return "", err
	}
	name := filepath.Base(cleaned)
	if err := UnitName(name); err != nil {
		return "", err
	}
	return cleaned, nil
}

// EnvPath validates that p is an instance env file under /etc/squad-server/.
func EnvPath(p string) (string, error) {
	cleaned, err := Path(p, SquadEnvDir)
	if err != nil {
		return "", err
	}
	name := filepath.Base(cleaned)
	if !regexp.MustCompile(`^instance-[a-f0-9-]{36}\.env$`).MatchString(name) {
		return "", fmt.Errorf("%w: env file %q does not match pattern", ErrForbidden, name)
	}
	return cleaned, nil
}

var uuidRegexp = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func uuidLike(s string) bool {
	return uuidRegexp.MatchString(s)
}
