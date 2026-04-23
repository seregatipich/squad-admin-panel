package validate

import (
	"errors"
	"testing"
)

func TestAptPackage(t *testing.T) {
	if err := AptPackage("curl"); err != nil {
		t.Errorf("curl should be allowed: %v", err)
	}
	if err := AptPackage("libsdl2-2.0-0:i386"); err != nil {
		t.Errorf("i386 arch variant should be allowed: %v", err)
	}
	if err := AptPackage("bash"); err == nil || !errors.Is(err, ErrForbidden) {
		t.Errorf("bash should be forbidden (not on whitelist), got %v", err)
	}
	if err := AptPackage("curl; rm -rf /"); err == nil {
		t.Error("shell injection attempt should be rejected")
	}
	if err := AptPackage("CURL"); err == nil {
		t.Error("uppercase package name should be rejected")
	}
	if err := AptPackage(""); err == nil {
		t.Error("empty name should be rejected")
	}
}

func TestAptPackageList(t *testing.T) {
	if err := AptPackageList([]string{"curl", "wget"}); err != nil {
		t.Errorf("valid list rejected: %v", err)
	}
	if err := AptPackageList([]string{}); err == nil {
		t.Error("empty list should be rejected")
	}
	if err := AptPackageList([]string{"curl", "curl"}); err == nil {
		t.Error("duplicate entry should be rejected")
	}
	if err := AptPackageList([]string{"curl", "netcat"}); err == nil {
		t.Error("one bad entry should fail the whole list")
	}
}
