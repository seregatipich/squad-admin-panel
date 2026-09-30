package validate

import (
	"fmt"
)

// ServerConfigsMount accepts only the exact ServerConfig directory of the
// server being launched — `<PanelConfigsRoot>/{serverID}/ServerConfig` — and
// returns the cleaned path to bind. Another server's directory, the per-server
// root, or any nested path is rejected, so container_run can never expose one
// server's configs to another server's container.
func ServerConfigsMount(p, serverID string) (string, error) {
	return exactServerPath(p, PanelConfigsRoot, PanelConfigsRoot+"/"+serverID+"/ServerConfig", "configs mount")
}

// ServerSavedMount accepts only the exact saved-data root of the server being
// launched — `<PanelSavedRoot>/{serverID}` — and returns the cleaned path.
func ServerSavedMount(p, serverID string) (string, error) {
	return exactServerPath(p, PanelSavedRoot, PanelSavedRoot+"/"+serverID, "saved mount")
}

func exactServerPath(p, root, want, label string) (string, error) {
	cleaned, err := Path(p, root)
	if err != nil {
		return "", err
	}
	if cleaned != want {
		return "", fmt.Errorf("%w: %s %q must be exactly %q", ErrForbidden, label, cleaned, want)
	}
	return cleaned, nil
}

// ServerPort bounds a game/query/beacon/RCON port to the unprivileged range,
// the same range the API's server schema enforces.
func ServerPort(port int) error {
	if port < 1024 || port > 65535 {
		return fmt.Errorf("%w: server port %d outside 1024..65535", ErrForbidden, port)
	}
	return nil
}
