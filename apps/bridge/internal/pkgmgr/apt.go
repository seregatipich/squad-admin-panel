// Package pkgmgr wraps apt-get for the 14 allow-listed packages. The
// validator rejects anything else before we get here; this layer is
// responsible for assembling the command and invoking it with the
// non-interactive environment overrides Debian expects.
package pkgmgr

import (
	"context"
	"fmt"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/runner"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

// APT installs the supplied Debian packages, idempotently. Any package
// already at the requested version is a no-op.
type APT struct {
	R runner.Runner
}

// Install installs the named packages. The caller is expected to have
// already validated the list via validate.AptPackageList.
func (a *APT) Install(ctx context.Context, pkgs []string) (string, error) {
	if err := validate.AptPackageList(pkgs); err != nil {
		return "", err
	}

	args := []string{
		"-y",
		"-o", "APT::Sandbox::User=root",
		"-o", "DPkg::Lock::Timeout=120",
		"-q",
		"install",
	}
	args = append(args, pkgs...)

	env := []string{
		"DEBIAN_FRONTEND=noninteractive",
		"LC_ALL=C.UTF-8",
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	}

	so, se, code, err := a.R.Run(ctx, "apt-get", args, env)
	if err != nil {
		return "", fmt.Errorf("apt-get: %w", err)
	}
	out := string(so) + string(se)
	if code != 0 {
		return out, fmt.Errorf("apt-get exit %d", code)
	}
	return out, nil
}
