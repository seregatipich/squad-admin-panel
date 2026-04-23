package pkgmgr

import (
	"context"
	"testing"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/runner"
)

func TestAptInstallHappyPath(t *testing.T) {
	fake := &runner.Fake{Stdout: []byte("Reading package lists... Done"), Exit: 0}
	apt := APT{R: fake}
	_, err := apt.Install(context.Background(), []string{"curl", "wget"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(fake.Calls))
	}
	call := fake.Calls[0]
	if call.Cmd != "apt-get" {
		t.Errorf("command = %q, want apt-get", call.Cmd)
	}
	foundCurl := false
	foundWget := false
	for _, a := range call.Args {
		if a == "curl" {
			foundCurl = true
		}
		if a == "wget" {
			foundWget = true
		}
	}
	if !foundCurl || !foundWget {
		t.Errorf("expected curl and wget in args, got %v", call.Args)
	}
	foundDFE := false
	for _, e := range call.Env {
		if e == "DEBIAN_FRONTEND=noninteractive" {
			foundDFE = true
		}
	}
	if !foundDFE {
		t.Error("DEBIAN_FRONTEND=noninteractive not set")
	}
}

func TestAptInstallRejectsNonWhitelisted(t *testing.T) {
	fake := &runner.Fake{}
	apt := APT{R: fake}
	_, err := apt.Install(context.Background(), []string{"bash"})
	if err == nil {
		t.Error("expected rejection for bash (not in whitelist)")
	}
	if len(fake.Calls) != 0 {
		t.Error("runner should not have been called for forbidden package")
	}
}

func TestAptInstallAbortsOnExitNonZero(t *testing.T) {
	fake := &runner.Fake{Exit: 100}
	apt := APT{R: fake}
	_, err := apt.Install(context.Background(), []string{"curl"})
	if err == nil {
		t.Error("expected error for exit=100")
	}
}
