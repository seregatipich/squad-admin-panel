package main

import (
	"bufio"
	"os"
	"strings"
	"testing"
)

// unitSectionKeys maps every "Key=" line of a systemd unit file to the
// [Section] it appears in.
func unitSectionKeys(t *testing.T, path string) map[string]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open unit: %v", err)
	}
	defer f.Close()
	keys := map[string]string{}
	section := ""
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = line
			continue
		}
		if key, _, ok := strings.Cut(line, "="); ok {
			keys[key] = section
		}
	}
	return keys
}

// Regression for #74 (finding #393): StartLimitIntervalSec/StartLimitBurst
// are [Unit] keys. Under [Service] systemd logs "Unknown key name ... ignoring"
// and the crash-loop guard of this root daemon silently falls back to the
// default 10 s window.
func TestServiceUnit_StartLimitKeysAreInUnitSection(t *testing.T) {
	keys := unitSectionKeys(t, "../../deploy/panel-host-bridge.service")
	for _, key := range []string{"StartLimitIntervalSec", "StartLimitBurst"} {
		if got := keys[key]; got != "[Unit]" {
			t.Errorf("%s is in section %q, want [Unit]", key, got)
		}
	}
}
