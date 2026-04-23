package validate

import (
	"fmt"
	"regexp"
	"strings"
)

// The SteamCMD whitelist is intentionally strict: every argument must
// match one of the allowed literal commands or one of the regex-based
// parametrised forms. No substring "contains" logic anywhere — one
// misplaced "+app_update" argument could download arbitrary code.

var (
	steamcmdInstallDir = regexp.MustCompile(
		`^\+force_install_dir /opt/squad-servers/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/?$`,
	)
)

// Argument slots; order matters because the platform flag must appear
// before login per §0A.9 corrections.
//
// Ordering constraints enforced by SteamCMDArgs:
//  1. First meaningful arg must be '+@sSteamCmdForcePlatformType linux'
//  2. '+login anonymous' must come AFTER the platform flag
//  3. '+app_update 403240 [validate]' must come AFTER login
//  4. Terminating '+quit' is optional but recommended
var steamcmdAllowedTokens = map[string]struct{}{
	"+@sSteamCmdForcePlatformType": {},
	"linux":                        {},
	"+@ShutdownOnFailedCommand":    {},
	"+@NoPromptForPassword":        {},
	"0":                            {},
	"1":                            {},
	"+login":                       {},
	"anonymous":                    {},
	"+app_update":                  {},
	"403240":                       {},
	"validate":                     {},
	"+quit":                        {},
	"+app_info_update":             {},
	"+app_info_print":              {},
}

// SteamCMDArgs is called by the bridge before spawning steamcmd.
// It returns the sanitised arg list (same as input on success).
// The caller is responsible for passing them without shell expansion.
func SteamCMDArgs(args []string) ([]string, error) {
	if len(args) == 0 {
		return nil, fmt.Errorf("%w: empty steamcmd args", ErrInvalidArgs)
	}

	var sawInstallDir, sawPlatform, sawLogin, sawAppUpdate bool
	platformIdx, loginIdx, appUpdateIdx := -1, -1, -1

	for i, a := range args {
		switch {
		case steamcmdInstallDir.MatchString(a):
			if sawInstallDir {
				return nil, fmt.Errorf("%w: duplicate +force_install_dir", ErrInvalidArgs)
			}
			sawInstallDir = true
		case strings.HasPrefix(a, "+force_install_dir"):
			return nil, fmt.Errorf("%w: install dir must be under /opt/squad-servers/{uuid}/", ErrForbidden)
		default:
			if _, ok := steamcmdAllowedTokens[a]; !ok {
				return nil, fmt.Errorf("%w: argument %q not in steamcmd whitelist", ErrForbidden, a)
			}
		}

		switch a {
		case "+@sSteamCmdForcePlatformType":
			sawPlatform = true
			platformIdx = i
		case "+login":
			sawLogin = true
			loginIdx = i
		case "+app_update":
			sawAppUpdate = true
			appUpdateIdx = i
		}
	}

	if !sawInstallDir {
		return nil, fmt.Errorf("%w: missing +force_install_dir", ErrInvalidArgs)
	}
	if !sawPlatform {
		return nil, fmt.Errorf("%w: missing +@sSteamCmdForcePlatformType linux (required for Squad on Linux)", ErrInvalidArgs)
	}
	if !sawLogin {
		return nil, fmt.Errorf("%w: missing +login anonymous", ErrInvalidArgs)
	}
	if !sawAppUpdate {
		return nil, fmt.Errorf("%w: missing +app_update 403240", ErrInvalidArgs)
	}
	// Ordering: platform must precede login must precede app_update.
	if platformIdx > loginIdx {
		return nil, fmt.Errorf("%w: +@sSteamCmdForcePlatformType must appear before +login", ErrInvalidArgs)
	}
	if loginIdx > appUpdateIdx {
		return nil, fmt.Errorf("%w: +login must appear before +app_update", ErrInvalidArgs)
	}

	return args, nil
}
