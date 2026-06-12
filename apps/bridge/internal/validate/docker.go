package validate

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	PanelDataRoot    = "/var/lib/squad-panel"
	PanelConfigsRoot = "/var/lib/squad-panel/configs"
	PanelSavedRoot   = "/var/lib/squad-panel/saved"
	DepotVolumeName  = "squad-depot"
	ServerImage      = "squad-server:latest"
	DepotInitImage   = "squad-panel/depot-init:latest"
	RNSquadJSImage   = "squad-panel/rnsquadjs:latest"
	PanelSocketRoot  = "/run/squad-panel/rnsquadjs"
)

var (
	serverContainerRegex    = regexp.MustCompile(`^squad-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
	depotJobRegex           = regexp.MustCompile(`^squad-depot-init-[0-9]{14}$`)
	rnsquadjsContainerRegex = regexp.MustCompile(`^rnsquadjs-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
	cfgFileRegex            = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}\.cfg$`)
	// allowedImages gates the caller-supplied image of the generic
	// container_run RPC. RNSquadJSImage is deliberately absent: the sidecar
	// image is launchable ONLY via container_run_rnsquadjs, which hardcodes
	// the image and applies sidecar-specific hardening (read-only rootfs,
	// uid 1001, isolated socket subdir). Allowing it here would let a
	// compromised API container launch the sidecar image with squad-server
	// mounts and bypass that hardening.
	allowedImages = map[string]struct{}{
		ServerImage:    {},
		DepotInitImage: {},
	}
	allowedCfgFiles = map[string]struct{}{
		"Admins.cfg":                {},
		"Bans.cfg":                  {},
		"CustomOptions.cfg":         {},
		"ExcludedFactions.cfg":      {},
		"ExcludedLayers.cfg":        {},
		"ExcludedLevels.cfg":        {},
		"LayerRotation.cfg":         {},
		"LayerVoting.cfg":           {},
		"LayerVotingLowPlayers.cfg": {},
		"LayerVotingNight.cfg":      {},
		"LevelRotation.cfg":         {},
		"License.cfg":               {},
		"MOTD.cfg":                  {},
		"Rcon.cfg":                  {},
		"RemoteAdminListHosts.cfg":  {},
		"RemoteBanListHosts.cfg":    {},
		"Server.cfg":                {},
		"ServerMessages.cfg":        {},
		"VoteConfig.cfg":            {},
	}
)

func ContainerName(name string) error {
	if !serverContainerRegex.MatchString(name) && !depotJobRegex.MatchString(name) && !rnsquadjsContainerRegex.MatchString(name) {
		return fmt.Errorf("%w: container name %q does not match allowed pattern", ErrForbidden, name)
	}
	return nil
}

func ServerUUID(uuid string) error {
	if !uuidRegexp.MatchString(uuid) {
		return fmt.Errorf("%w: uuid %q is not a UUID", ErrForbidden, uuid)
	}
	return nil
}

func ContainerImage(image string) error {
	if _, ok := allowedImages[image]; !ok {
		return fmt.Errorf("%w: image %q not in allowlist", ErrForbidden, image)
	}
	return nil
}

func PanelConfigsPath(p string) (string, error) {
	cleaned, err := Path(p, PanelConfigsRoot)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(PanelConfigsRoot, cleaned)
	if err != nil {
		return "", fmt.Errorf("%w: cannot derive relative path", ErrForbidden)
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) < 1 || !uuidLike(parts[0]) {
		return "", fmt.Errorf("%w: configs path missing uuid segment", ErrForbidden)
	}
	return cleaned, nil
}

func PanelConfigFilename(name string) error {
	if !cfgFileRegex.MatchString(name) {
		return fmt.Errorf("%w: config filename %q fails syntax check", ErrForbidden, name)
	}
	if _, ok := allowedCfgFiles[name]; !ok {
		return fmt.Errorf("%w: config file %q not in allowlist", ErrForbidden, name)
	}
	return nil
}

func PanelConfigFilePath(p string) (string, error) {
	cleaned, err := PanelConfigsPath(p)
	if err != nil {
		return "", err
	}
	rel, _ := filepath.Rel(PanelConfigsRoot, cleaned)
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) != 3 || parts[1] != "ServerConfig" {
		return "", fmt.Errorf("%w: config path must be %s/{uuid}/ServerConfig/{file}.cfg", ErrForbidden, PanelConfigsRoot)
	}
	if err := PanelConfigFilename(parts[2]); err != nil {
		return "", err
	}
	return cleaned, nil
}

func PanelSavedPath(p string) (string, error) {
	cleaned, err := Path(p, PanelSavedRoot)
	if err != nil {
		return "", err
	}
	rel, _ := filepath.Rel(PanelSavedRoot, cleaned)
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) < 1 || !uuidLike(parts[0]) {
		return "", fmt.Errorf("%w: saved path missing uuid segment", ErrForbidden)
	}
	return cleaned, nil
}

// PanelConfigsServerRoot accepts only the exact `<PanelConfigsRoot>/{uuid}`
// directory (no trailing components, no trailing slash, no traversal).
// Used by directory_delete to bound the destructive blast radius.
func PanelConfigsServerRoot(p string) (string, error) {
	return panelServerRoot(p, PanelConfigsRoot, "configs")
}

// PanelSavedServerRoot accepts only the exact `<PanelSavedRoot>/{uuid}`
// directory. Same constraints as PanelConfigsServerRoot.
func PanelSavedServerRoot(p string) (string, error) {
	return panelServerRoot(p, PanelSavedRoot, "saved")
}

func panelServerRoot(p, root, label string) (string, error) {
	cleaned, err := Path(p, root)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, cleaned)
	if err != nil {
		return "", fmt.Errorf("%w: cannot derive relative path", ErrForbidden)
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) != 1 {
		return "", fmt.Errorf("%w: %s server root must be exactly %s/{uuid}", ErrForbidden, label, root)
	}
	if !uuidLike(parts[0]) {
		return "", fmt.Errorf("%w: %s server root segment %q is not a uuid", ErrForbidden, label, parts[0])
	}
	return cleaned, nil
}
