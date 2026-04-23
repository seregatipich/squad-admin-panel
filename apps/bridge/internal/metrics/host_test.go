package metrics

import "testing"

func TestInfoReturnsPopulated(t *testing.T) {
	info, err := Info()
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if info.Hostname == "" {
		t.Error("hostname should be populated")
	}
	if info.Arch == "" {
		t.Error("arch should be populated")
	}
	if info.CPUCores < 1 {
		t.Error("cpu cores should be >= 1")
	}
	if info.Kernel == "" {
		t.Error("kernel should be populated")
	}
	if info.OSName == "" {
		t.Error("os name should be populated")
	}
}

func TestMetricsReturnsSample(t *testing.T) {
	_, prev, err := Metrics(nil, "/")
	if err != nil {
		t.Fatalf("first Metrics: %v", err)
	}
	cur, _, err := Metrics(prev, "/")
	if err != nil {
		t.Fatalf("second Metrics: %v", err)
	}
	if cur.RAMTotalBytes <= 0 {
		t.Error("ram total should be positive")
	}
	if cur.DiskTotalBytes <= 0 {
		t.Error("disk total should be positive")
	}
	if cur.SampledAt.IsZero() {
		t.Error("sampled_at should be set")
	}
}
