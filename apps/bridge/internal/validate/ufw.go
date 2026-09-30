package validate

import (
	"fmt"
	"regexp"
)

// UFWAction is add | remove.
func UFWAction(a string) error {
	if a != "add" && a != "remove" {
		return fmt.Errorf("%w: ufw action %q not in {add,remove}", ErrForbidden, a)
	}
	return nil
}

// UFWProto is tcp | udp.
func UFWProto(p string) error {
	if p != "tcp" && p != "udp" {
		return fmt.Errorf("%w: ufw proto %q not in {tcp,udp}", ErrForbidden, p)
	}
	return nil
}

// UFWPort bounds the port to the unprivileged user range.
func UFWPort(port int) error {
	if port < 1024 || port > 65535 {
		return fmt.Errorf("%w: ufw port %d outside 1024..65535", ErrForbidden, port)
	}
	return nil
}

// ufwCommentRegex matches the panel's own rule tags (squad-<kind>-<8 hex>):
// lowercase, starting with a letter, at most 64 characters. It keeps flag-like
// tokens, whitespace and control bytes out of the privileged ufw argv and of
// /etc/ufw/user.rules.
var ufwCommentRegex = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

// UFWComment accepts an empty comment (none is passed to ufw) or a tag
// matching ufwCommentRegex.
func UFWComment(comment string) error {
	if comment == "" {
		return nil
	}
	if !ufwCommentRegex.MatchString(comment) {
		return fmt.Errorf("%w: ufw comment %q must match %s", ErrForbidden, comment, ufwCommentRegex)
	}
	return nil
}
