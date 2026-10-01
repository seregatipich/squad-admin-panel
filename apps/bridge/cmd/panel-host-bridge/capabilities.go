package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// requiredCapabilities are the Linux capabilities the bridge needs in its
// bounding set (bit numbers from linux/capability.h). The unit file grants
// them; a host still running an older unit silently lacks them and the
// sidecar launch then fails with a bare EPERM from fchown.
var requiredCapabilities = []struct {
	name string
	bit  uint
}{
	{"CAP_CHOWN", 0},
	{"CAP_FOWNER", 3},
	{"CAP_NET_ADMIN", 12},
}

// missingCapabilities parses the CapBnd line of a /proc/<pid>/status stream
// and returns the names of the required capabilities absent from the bounding
// set. It returns an error when the line is missing or malformed.
func missingCapabilities(status io.Reader) ([]string, error) {
	scanner := bufio.NewScanner(status)
	for scanner.Scan() {
		value, found := strings.CutPrefix(scanner.Text(), "CapBnd:")
		if !found {
			continue
		}
		bounding, err := strconv.ParseUint(strings.TrimSpace(value), 16, 64)
		if err != nil {
			return nil, fmt.Errorf("parse CapBnd %q: %w", value, err)
		}
		var missing []string
		for _, capability := range requiredCapabilities {
			if bounding&(1<<capability.bit) == 0 {
				missing = append(missing, capability.name)
			}
		}
		return missing, nil
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("CapBnd line not found")
}

// capabilityDrift reports the required capabilities this process lacks, or nil
// when it holds them all or is not root (a non-root development bridge cannot
// drive containers anyway). Read failures are returned, not treated as drift.
func capabilityDrift() ([]string, error) {
	if os.Geteuid() != 0 {
		return nil, nil
	}
	status, err := os.Open("/proc/self/status")
	if err != nil {
		return nil, err
	}
	defer status.Close()
	return missingCapabilities(status)
}
