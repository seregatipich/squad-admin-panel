package validate

import "testing"

func TestUFWAction(t *testing.T) {
	for _, good := range []string{"add", "remove"} {
		if err := UFWAction(good); err != nil {
			t.Errorf("%q should be allowed: %v", good, err)
		}
	}
	for _, bad := range []string{"", "delete", "purge", "allow"} {
		if err := UFWAction(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestUFWProto(t *testing.T) {
	for _, good := range []string{"tcp", "udp"} {
		if err := UFWProto(good); err != nil {
			t.Errorf("%q should be allowed: %v", good, err)
		}
	}
	for _, bad := range []string{"", "icmp", "raw", "any"} {
		if err := UFWProto(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestUFWPort(t *testing.T) {
	for _, good := range []int{1024, 7787, 27165, 65535} {
		if err := UFWPort(good); err != nil {
			t.Errorf("port %d should be allowed: %v", good, err)
		}
	}
	for _, bad := range []int{-1, 0, 22, 80, 1023, 65536, 100000} {
		if err := UFWPort(bad); err == nil {
			t.Errorf("port %d should be rejected", bad)
		}
	}
}
