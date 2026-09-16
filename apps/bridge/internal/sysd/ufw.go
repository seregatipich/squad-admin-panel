package sysd

import (
	"context"
	"fmt"
	"strconv"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/runner"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/validate"
)

// UFW wraps ufw for adding and removing Squad-server firewall rules.
type UFW struct {
	R runner.Runner
}

// Rule manipulates a single ufw allow rule for <port>/<proto> with a
// comment tag so the panel can recognise and remove its own rules.
func (u *UFW) Rule(ctx context.Context, action, proto string, port int, comment string) (string, error) {
	if err := validate.UFWAction(action); err != nil {
		return "", err
	}
	if err := validate.UFWProto(proto); err != nil {
		return "", err
	}
	if err := validate.UFWPort(port); err != nil {
		return "", err
	}

	// Map panel-level action to ufw CLI verb: add → "allow", remove → "delete allow".
	var args []string
	switch action {
	case "add":
		args = []string{"allow"}
	case "remove":
		args = []string{"delete", "allow"}
	}
	args = append(args, strconv.Itoa(port)+"/"+proto)
	if comment != "" {
		args = append(args, "comment", comment)
	}

	so, se, code, err := u.R.Run(ctx, "ufw", args, nil)
	if err != nil {
		return "", fmt.Errorf("ufw: %w", err)
	}
	out := string(so) + string(se)
	if code != 0 {
		return out, fmt.Errorf("ufw exit %d: %s", code, out)
	}
	return out, nil
}
