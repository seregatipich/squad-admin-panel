package metrics

import (
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

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
	if info.UptimeSeconds <= 0 {
		t.Error("uptime should be populated")
	}
	if info.IPAddresses == nil {
		t.Error("ip_addresses slice should not be nil (use [] when empty)")
	}
}

func TestMetricsCacheReturnsLiveSample(t *testing.T) {
	cache := NewMetricsCache(nil, nil, 0)
	cache.Sample("/")
	cur := cache.Sample("/")
	if cur.RAMTotalBytes <= 0 {
		t.Error("ram total should be positive")
	}
	if cur.DiskTotalBytes <= 0 {
		t.Error("disk total should be positive")
	}
	if cur.SampledAt.IsZero() {
		t.Error("sampled_at should be set")
	}
	if cur.LoadAvg1m < 0 || cur.LoadAvg5m < 0 || cur.LoadAvg15m < 0 {
		t.Error("loadavg fields should be non-negative")
	}
}

func TestParseUptime(t *testing.T) {
	cases := []struct {
		in   string
		want int64
	}{
		{"12345.67 9876.54\n", 12346},
		{"100.0 50.0", 100},
		{"0.49 0.10\n", 0},
	}
	for _, tc := range cases {
		got, err := parseUptime(tc.in)
		if err != nil {
			t.Fatalf("parseUptime(%q): %v", tc.in, err)
		}
		if got != tc.want {
			t.Errorf("parseUptime(%q)=%d want %d", tc.in, got, tc.want)
		}
	}
}

func TestParseUptime_BadInput(t *testing.T) {
	bad := []string{"", "not-a-number\n", "abc def"}
	for _, b := range bad {
		if _, err := parseUptime(b); err == nil {
			t.Errorf("parseUptime(%q) expected error", b)
		}
	}
}

func TestReadUptime_FromFixture(t *testing.T) {
	tmp, err := os.CreateTemp(t.TempDir(), "uptime")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tmp.WriteString("987654.32 123456.78\n"); err != nil {
		t.Fatal(err)
	}
	tmp.Close()
	prev := uptimePath
	uptimePath = tmp.Name()
	t.Cleanup(func() { uptimePath = prev })

	got, err := readUptime()
	if err != nil {
		t.Fatalf("readUptime: %v", err)
	}
	if got != 987654 {
		t.Errorf("readUptime=%d want 987654", got)
	}
}

func TestParseLoadAvg(t *testing.T) {
	la1, la5, la15, err := parseLoadAvg("0.42 0.51 0.49 1/234 12345\n")
	if err != nil {
		t.Fatalf("parseLoadAvg: %v", err)
	}
	if la1 != 0.42 || la5 != 0.51 || la15 != 0.49 {
		t.Errorf("parseLoadAvg got %v %v %v", la1, la5, la15)
	}
}

func TestParseLoadAvg_BadInput(t *testing.T) {
	if _, _, _, err := parseLoadAvg("only two fields\n"); err == nil {
		t.Error("expected error on truncated loadavg input")
	}
	if _, _, _, err := parseLoadAvg(""); err == nil {
		t.Error("expected error on empty loadavg input")
	}
}

func TestReadLoadAvg_FromFixture(t *testing.T) {
	tmp, err := os.CreateTemp(t.TempDir(), "loadavg")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tmp.WriteString("1.23 2.34 3.45 1/100 999\n"); err != nil {
		t.Fatal(err)
	}
	tmp.Close()
	prev := loadAvgPath
	loadAvgPath = tmp.Name()
	t.Cleanup(func() { loadAvgPath = prev })

	la1, la5, la15, err := readLoadAvg()
	if err != nil {
		t.Fatalf("readLoadAvg: %v", err)
	}
	if la1 != 1.23 || la5 != 2.34 || la15 != 3.45 {
		t.Errorf("readLoadAvg got %v %v %v", la1, la5, la15)
	}
}

func TestFilterIPs_RejectsLoopbackAndLinkLocal(t *testing.T) {
	addrs := []net.Addr{
		&net.IPNet{IP: net.ParseIP("127.0.0.1"), Mask: net.CIDRMask(8, 32)},
		&net.IPNet{IP: net.ParseIP("169.254.1.7"), Mask: net.CIDRMask(16, 32)},
		&net.IPNet{IP: net.ParseIP("10.0.0.5"), Mask: net.CIDRMask(8, 32)},
		&net.IPNet{IP: net.ParseIP("192.168.1.10"), Mask: net.CIDRMask(24, 32)},
		&net.IPNet{IP: net.ParseIP("::1"), Mask: net.CIDRMask(128, 128)},
		&net.IPNet{IP: net.ParseIP("fe80::1"), Mask: net.CIDRMask(64, 128)},
	}
	got := filterIPs(addrs)
	want := []string{"10.0.0.5", "192.168.1.10"}
	if len(got) != len(want) {
		t.Fatalf("filterIPs len=%d want %d (got=%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("filterIPs[%d]=%q want %q (sorted output)", i, got[i], want[i])
		}
	}
}

func TestReadIPAddresses_FiltersLoopbackAndLinkLocal(t *testing.T) {
	got := readIPAddresses()
	for _, ip := range got {
		parsed := net.ParseIP(ip)
		if parsed == nil || parsed.To4() == nil {
			t.Errorf("expected non-nil ipv4, got %q", ip)
		}
		if parsed.IsLoopback() {
			t.Errorf("loopback %q should have been filtered", ip)
		}
		if parsed.IsLinkLocalUnicast() {
			t.Errorf("link-local %q should have been filtered", ip)
		}
	}
}

func TestReadDockerVersion_GracefulWhenAbsent(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	got := readDockerVersion()
	if got != "" {
		t.Errorf("expected empty string when docker absent, got %q", got)
	}
}

func TestReadDockerVersion_LiveBestEffort(t *testing.T) {
	got := readDockerVersion()
	if got != "" && !strings.Contains(strings.ToLower(got), "docker") {
		t.Errorf("non-empty docker version should contain 'docker', got %q", got)
	}
}

func TestMetricsCache_FirstCallReturnsZeroDeltas(t *testing.T) {
	now := time.Date(2026, 4, 24, 10, 0, 0, 0, time.UTC)
	clk := &fakeClock{now: now}
	cnt := 0
	cap := func() *sample {
		cnt++
		return &sample{
			idle:      uint64(cnt) * 1000,
			total:     uint64(cnt) * 10000,
			net:       map[string]netCounters{"eth0": {rx: uint64(cnt) * 5000, tx: uint64(cnt) * 7000}},
			sampledAt: clk.Now(),
		}
	}

	cache := NewMetricsCache(cap, clk.Now, 200*time.Millisecond)
	m := cache.Sample("/")
	if m.CPUPercent != 0 {
		t.Errorf("first call CPUPercent=%v want 0", m.CPUPercent)
	}
	if m.NetRxBytesPerSec != 0 || m.NetTxBytesPerSec != 0 {
		t.Errorf("first call net rates not zero: rx=%v tx=%v", m.NetRxBytesPerSec, m.NetTxBytesPerSec)
	}
}

func TestMetricsCache_BelowThresholdSkipsDelta(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 4, 24, 10, 0, 0, 0, time.UTC)}
	calls := []*sample{
		{idle: 1000, total: 10000, net: map[string]netCounters{"eth0": {rx: 5000, tx: 7000}}, sampledAt: clk.Now()},
		{idle: 2000, total: 20000, net: map[string]netCounters{"eth0": {rx: 15000, tx: 21000}}, sampledAt: clk.Now().Add(50 * time.Millisecond)},
	}
	idx := 0
	cap := func() *sample {
		s := calls[idx]
		idx++
		return s
	}
	cache := NewMetricsCache(cap, clk.Now, 200*time.Millisecond)
	cache.Sample("/")
	clk.now = clk.now.Add(50 * time.Millisecond)
	m := cache.Sample("/")
	if m.CPUPercent != 0 {
		t.Errorf("under-threshold delta should be 0, got %v", m.CPUPercent)
	}
	if m.NetRxBytesPerSec != 0 || m.NetTxBytesPerSec != 0 {
		t.Errorf("under-threshold net rates should be 0, got rx=%v tx=%v", m.NetRxBytesPerSec, m.NetTxBytesPerSec)
	}
}

func TestMetricsCache_AboveThresholdComputesDelta(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 4, 24, 10, 0, 0, 0, time.UTC)}
	calls := []*sample{
		{idle: 1000, total: 10000, net: map[string]netCounters{"eth0": {rx: 5000, tx: 7000}}, sampledAt: clk.Now()},
		{idle: 2000, total: 20000, net: map[string]netCounters{"eth0": {rx: 15000, tx: 21000}}, sampledAt: clk.Now().Add(250 * time.Millisecond)},
	}
	idx := 0
	cap := func() *sample {
		s := calls[idx]
		idx++
		return s
	}
	cache := NewMetricsCache(cap, clk.Now, 200*time.Millisecond)
	cache.Sample("/")
	clk.now = clk.now.Add(250 * time.Millisecond)
	m := cache.Sample("/")
	if m.CPUPercent <= 0 {
		t.Errorf("above-threshold CPUPercent should be > 0, got %v", m.CPUPercent)
	}
	if m.NetRxBytesPerSec <= 0 {
		t.Errorf("above-threshold NetRxBytesPerSec should be > 0, got %v", m.NetRxBytesPerSec)
	}
	if m.NetTxBytesPerSec <= 0 {
		t.Errorf("above-threshold NetTxBytesPerSec should be > 0, got %v", m.NetTxBytesPerSec)
	}
}

type fakeClock struct {
	now time.Time
}

func (f *fakeClock) Now() time.Time { return f.now }

// Regression for #45 (finding #410): when a container restarts its veth
// disappears and the summed counters drop; a bare uint64 subtraction then
// wrapped to ~1.8e19 B/s. Counters that went backwards (and an idle counter
// that stepped back) must never produce garbage rates.
func TestMetricsCache_DecreasingCountersNeverWrap(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 4, 24, 10, 0, 0, 0, time.UTC)}
	calls := []*sample{
		{idle: 5000, total: 10000, net: map[string]netCounters{"eth0": {rx: 15000, tx: 21000}}, sampledAt: clk.Now()},
		{idle: 4000, total: 20000, net: map[string]netCounters{"eth0": {rx: 5000, tx: 7000}}, sampledAt: clk.Now().Add(time.Second)},
	}
	idx := 0
	cache := NewMetricsCache(func() *sample { s := calls[idx]; idx++; return s }, clk.Now, 200*time.Millisecond)
	cache.Sample("/")
	m := cache.Sample("/")
	if m.NetRxBytesPerSec < 0 || m.NetRxBytesPerSec > 1e12 || m.NetTxBytesPerSec < 0 || m.NetTxBytesPerSec > 1e12 {
		t.Fatalf("net rates wrapped: rx=%v tx=%v", m.NetRxBytesPerSec, m.NetTxBytesPerSec)
	}
	if m.CPUPercent < 0 || m.CPUPercent > 100 {
		t.Fatalf("cpu_percent out of [0,100]: %v", m.CPUPercent)
	}
}

func TestNetDelta_InterfaceChurnAndResetContributeNothing(t *testing.T) {
	prev := map[string]netCounters{"eth0": {rx: 1000, tx: 2000}, "eth1": {rx: 500, tx: 500}}
	cur := map[string]netCounters{"eth0": {rx: 1500, tx: 1000}, "eth2": {rx: 9999, tx: 9999}}
	rx, tx := netDelta(prev, cur)
	if rx != 500 || tx != 0 {
		t.Fatalf("netDelta = (%d, %d), want (500, 0): only eth0 rx grew", rx, tx)
	}
}

func TestParseNetDev_SkipsVirtualInterfaces(t *testing.T) {
	const procNetDev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9000 10 0 0 0 0 0 0 9000 10 0 0 0 0 0 0
  eth0: 1000 10 0 0 0 0 0 0 2000 10 0 0 0 0 0 0
docker0: 300 1 0 0 0 0 0 0 300 1 0 0 0 0 0 0
br-1a2b3c: 400 1 0 0 0 0 0 0 400 1 0 0 0 0 0 0
vethabc123: 500 1 0 0 0 0 0 0 500 1 0 0 0 0 0 0
`
	got := parseNetDev(strings.NewReader(procNetDev))
	if len(got) != 1 {
		t.Fatalf("parsed %v, want only eth0", got)
	}
	if got["eth0"] != (netCounters{rx: 1000, tx: 2000}) {
		t.Fatalf("eth0 = %+v, want rx=1000 tx=2000", got["eth0"])
	}
}

func TestCPUPercent_ClampedAndNoWrap(t *testing.T) {
	cases := []struct {
		name      string
		prev, cur sample
		want      float64
	}{
		{"idle stepped back", sample{idle: 5000, total: 10000}, sample{idle: 4000, total: 20000}, 100},
		{"total unchanged", sample{idle: 1, total: 10}, sample{idle: 1, total: 10}, 0},
		{"total went back", sample{idle: 1, total: 10}, sample{idle: 1, total: 5}, 0},
		{"idle exceeds total delta", sample{idle: 0, total: 0}, sample{idle: 200, total: 100}, 0},
		{"half busy", sample{idle: 0, total: 0}, sample{idle: 50, total: 100}, 50},
	}
	for _, c := range cases {
		if got := cpuPercent(&c.prev, &c.cur); got != c.want {
			t.Errorf("%s: cpuPercent = %v, want %v", c.name, got, c.want)
		}
	}
}
