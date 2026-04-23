package validate

import "fmt"

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
