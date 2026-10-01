package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestMissingCapabilities(t *testing.T) {
	cases := []struct {
		name   string
		status string
		want   []string
	}{
		{"stale unit with only DAC and NET_ADMIN", "Name:\tbridge\nCapBnd:\t0000000000001006\n", []string{"CAP_CHOWN", "CAP_FOWNER"}},
		{"current unit", "CapBnd:\t0000000000001009\n", nil},
		{"full set", "CapBnd:\t000001ffffffffff\n", nil},
		{"empty set", "CapBnd:\t0000000000000000\n", []string{"CAP_CHOWN", "CAP_FOWNER", "CAP_NET_ADMIN"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := missingCapabilities(strings.NewReader(tc.status))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("missing = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMissingCapabilitiesRejectsBadInput(t *testing.T) {
	for name, status := range map[string]string{
		"no CapBnd line": "Name:\tbridge\n",
		"not hex":        "CapBnd:\tzzzz\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := missingCapabilities(strings.NewReader(status)); err == nil {
				t.Error("expected an error")
			}
		})
	}
}
