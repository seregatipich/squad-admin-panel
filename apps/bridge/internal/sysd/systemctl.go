// Package sysd wraps the systemctl CLI for the operations the bridge
// exposes. Using the CLI (instead of raw dbus) keeps the permission
// surface easy to reason about — systemctl already encapsulates all
// the subtleties of the D-Bus call with the same verbs we expose.
package sysd

import (
	"context"
	"fmt"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/runner"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

// Client calls systemctl on behalf of the RPC handlers.
type Client struct {
	R runner.Runner
}

// Action runs `systemctl <action> <unit>`.
func (c *Client) Action(ctx context.Context, action, unit string) (string, error) {
	if err := validate.Action(action); err != nil {
		return "", err
	}
	if err := validate.UnitName(unit); err != nil {
		return "", err
	}
	so, se, code, err := c.R.Run(ctx, "systemctl", []string{action, unit}, nil)
	if err != nil {
		return "", fmt.Errorf("systemctl: %w", err)
	}
	out := string(so) + string(se)
	// `is-active` and `status` return non-zero exit codes when the unit is
	// not active (1=inactive/dead, 3=failed, 4=not-found). Callers need the
	// output verbatim to reason about state, so treat those as data-not-error.
	if action == "is-active" || action == "status" {
		return out, nil
	}
	if code != 0 {
		return out, fmt.Errorf("systemctl exited %d: %s", code, out)
	}
	return out, nil
}

// DaemonReload runs `systemctl daemon-reload`.
func (c *Client) DaemonReload(ctx context.Context) error {
	_, se, code, err := c.R.Run(ctx, "systemctl", []string{"daemon-reload"}, nil)
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("daemon-reload exit %d: %s", code, string(se))
	}
	return nil
}

// IsActive returns true if systemctl is-active returns "active".
func (c *Client) IsActive(ctx context.Context, unit string) (bool, string, error) {
	if err := validate.UnitName(unit); err != nil {
		return false, "", err
	}
	so, _, _, err := c.R.Run(ctx, "systemctl", []string{"is-active", unit}, nil)
	if err != nil {
		return false, "", err
	}
	state := string(so)
	if len(state) > 0 && state[len(state)-1] == '\n' {
		state = state[:len(state)-1]
	}
	return state == "active", state, nil
}
