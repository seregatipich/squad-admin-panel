// Package metrics reads the host's OS release, kernel, CPU, and
// utilisation stats for host_info / host_metrics RPC methods.
package metrics

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// HostInfo is the static snapshot returned by host_info.
type HostInfo struct {
	Hostname      string   `json:"hostname"`
	OSName        string   `json:"os_name"`
	OSVersion     string   `json:"os_version"`
	Kernel        string   `json:"kernel"`
	Arch          string   `json:"arch"`
	CPUModel      string   `json:"cpu_model"`
	CPUCores      int      `json:"cpu_cores"`
	RAMTotalBytes int64    `json:"ram_total_bytes"`
	UptimeSeconds int64    `json:"uptime_seconds"`
	DockerVersion string   `json:"docker_version"`
	IPAddresses   []string `json:"ip_addresses"`
}

// HostMetrics is the live sample returned by host_metrics.
type HostMetrics struct {
	CPUPercent       float64   `json:"cpu_percent"`
	RAMUsedBytes     int64     `json:"ram_used_bytes"`
	RAMTotalBytes    int64     `json:"ram_total_bytes"`
	DiskUsedBytes    int64     `json:"disk_used_bytes"`
	DiskTotalBytes   int64     `json:"disk_total_bytes"`
	NetRxBytesPerSec float64   `json:"net_rx_bytes_per_sec"`
	NetTxBytesPerSec float64   `json:"net_tx_bytes_per_sec"`
	LoadAvg1m        float64   `json:"load_avg_1m"`
	LoadAvg5m        float64   `json:"load_avg_5m"`
	LoadAvg15m       float64   `json:"load_avg_15m"`
	SampledAt        time.Time `json:"sampled_at"`
}

// Info returns HostInfo populated from /etc/os-release and runtime info.
func Info() (HostInfo, error) {
	hn, _ := os.Hostname()
	h := HostInfo{
		Hostname:    hn,
		Arch:        runtime.GOARCH,
		CPUCores:    runtime.NumCPU(),
		IPAddresses: []string{},
	}
	osName, osVer := readOSRelease()
	h.OSName = osName
	h.OSVersion = osVer
	h.Kernel = readKernelVersion()
	h.CPUModel = readCPUModel()
	if mem, err := readMemTotal(); err == nil {
		h.RAMTotalBytes = mem
	}
	if up, err := readUptime(); err == nil {
		h.UptimeSeconds = up
	}
	h.DockerVersion = readDockerVersion()
	if ips := readIPAddresses(); ips != nil {
		h.IPAddresses = ips
	}
	return h, nil
}

// Metrics returns a fresh HostMetrics sample. CPU and network rates are
// computed as differentials over the supplied prior sample (if any).
func Metrics(prev *sample, mountpoint string) (HostMetrics, *sample, error) {
	cur := captureSample()
	m := HostMetrics{SampledAt: time.Now().UTC()}

	if prev != nil {
		m.CPUPercent = cpuPercent(prev, cur)
		dt := cur.sampledAt.Sub(prev.sampledAt).Seconds()
		if dt > 0 {
			m.NetRxBytesPerSec = float64(cur.netRx-prev.netRx) / dt
			m.NetTxBytesPerSec = float64(cur.netTx-prev.netTx) / dt
		}
	}
	if mem, err := readMemUsed(); err == nil {
		m.RAMUsedBytes = mem.used
		m.RAMTotalBytes = mem.total
	}
	if du, err := readDisk(mountpoint); err == nil {
		m.DiskUsedBytes = du.used
		m.DiskTotalBytes = du.total
	}
	if la1, la5, la15, err := readLoadAvg(); err == nil {
		m.LoadAvg1m = la1
		m.LoadAvg5m = la5
		m.LoadAvg15m = la15
	}
	return m, cur, nil
}

// MetricsCache holds the last raw sample so consecutive host_metrics RPC
// calls produce real CPU / network rate deltas. The previous implementation
// captured two samples back-to-back inside one RPC call, which made dt
// effectively microseconds and the resulting rate always 0.
type MetricsCache struct {
	mu        sync.Mutex
	last      *sample
	capture   func() *sample
	now       func() time.Time
	threshold time.Duration
}

// NewMetricsCache builds a cache. capture and now are injectable so tests
// can drive the cache deterministically. threshold is the minimum age of
// the previous sample before we'll compute a delta against it (200ms is
// reasonable for the 4s api poll cadence).
func NewMetricsCache(capture func() *sample, now func() time.Time, threshold time.Duration) *MetricsCache {
	if capture == nil {
		capture = captureSample
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &MetricsCache{capture: capture, now: now, threshold: threshold}
}

// Sample returns a HostMetrics computed against the previously cached
// sample. First call (and any call within `threshold` of the previous)
// returns zero deltas.
func (c *MetricsCache) Sample(mountpoint string) HostMetrics {
	c.mu.Lock()
	defer c.mu.Unlock()

	cur := c.capture()
	m := HostMetrics{SampledAt: c.now().UTC()}

	if c.last != nil {
		dt := cur.sampledAt.Sub(c.last.sampledAt)
		if dt >= c.threshold {
			m.CPUPercent = cpuPercent(c.last, cur)
			secs := dt.Seconds()
			if secs > 0 {
				m.NetRxBytesPerSec = float64(cur.netRx-c.last.netRx) / secs
				m.NetTxBytesPerSec = float64(cur.netTx-c.last.netTx) / secs
			}
		}
	}
	c.last = cur

	if mem, err := readMemUsed(); err == nil {
		m.RAMUsedBytes = mem.used
		m.RAMTotalBytes = mem.total
	}
	if du, err := readDisk(mountpoint); err == nil {
		m.DiskUsedBytes = du.used
		m.DiskTotalBytes = du.total
	}
	if la1, la5, la15, err := readLoadAvg(); err == nil {
		m.LoadAvg1m = la1
		m.LoadAvg5m = la5
		m.LoadAvg15m = la15
	}
	return m
}

// sample is the raw counters we cache between Metrics() calls.
type sample struct {
	idle, total uint64
	netRx       uint64
	netTx       uint64
	sampledAt   time.Time
}

func captureSample() *sample {
	s := &sample{sampledAt: time.Now().UTC()}
	if idle, total, err := readCPU(); err == nil {
		s.idle, s.total = idle, total
	}
	rx, tx := readNet()
	s.netRx = rx
	s.netTx = tx
	return s
}

func cpuPercent(prev, cur *sample) float64 {
	idleDelta := cur.idle - prev.idle
	totalDelta := cur.total - prev.total
	if totalDelta == 0 {
		return 0
	}
	return 100.0 * (1.0 - float64(idleDelta)/float64(totalDelta))
}

func readOSRelease() (name, version string) {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return "unknown", ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "NAME=") {
			name = strings.Trim(strings.TrimPrefix(line, "NAME="), `"`)
		} else if strings.HasPrefix(line, "VERSION=") {
			version = strings.Trim(strings.TrimPrefix(line, "VERSION="), `"`)
		}
	}
	return
}

func readKernelVersion() string {
	var utsname unix.Utsname
	if err := unix.Uname(&utsname); err != nil {
		return "unknown"
	}
	return strings.TrimRight(string(utsname.Release[:]), "\x00")
}

func readCPUModel() string {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return "unknown"
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "model name") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return "unknown"
}

func readMemTotal() (int64, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ := strconv.ParseInt(fields[1], 10, 64)
				return kb * 1024, nil
			}
		}
	}
	return 0, nil
}

type memStats struct {
	total, used int64
}

func readMemUsed() (memStats, error) {
	var m memStats
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return m, err
	}
	defer f.Close()
	var memTotal, memAvail int64
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		kb, _ := strconv.ParseInt(fields[1], 10, 64)
		switch fields[0] {
		case "MemTotal:":
			memTotal = kb * 1024
		case "MemAvailable:":
			memAvail = kb * 1024
		}
	}
	m.total = memTotal
	m.used = memTotal - memAvail
	return m, nil
}

func readCPU() (idle, total uint64, err error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	if !scanner.Scan() {
		return 0, 0, nil
	}
	line := scanner.Text()
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0, nil
	}
	var vals []uint64
	for _, f := range fields[1:] {
		v, _ := strconv.ParseUint(f, 10, 64)
		vals = append(vals, v)
	}
	if len(vals) < 4 {
		return 0, 0, nil
	}
	idle = vals[3]
	for _, v := range vals {
		total += v
	}
	return
}

func readNet() (rx, tx uint64) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Scan() // header
	scanner.Scan() // header
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}
		iface := strings.TrimSuffix(fields[0], ":")
		if iface == "lo" {
			continue
		}
		r, _ := strconv.ParseUint(fields[1], 10, 64)
		t, _ := strconv.ParseUint(fields[9], 10, 64)
		rx += r
		tx += t
	}
	return
}

type diskStats struct {
	used, total int64
}

func readDisk(mountpoint string) (diskStats, error) {
	var fs unix.Statfs_t
	if err := unix.Statfs(mountpoint, &fs); err != nil {
		return diskStats{}, err
	}
	blockSize := int64(fs.Bsize)
	total := int64(fs.Blocks) * blockSize
	free := int64(fs.Bavail) * blockSize
	return diskStats{total: total, used: total - free}, nil
}

// uptimePath / loadAvgPath are package-level so tests can swap in fixtures.
var (
	uptimePath  = "/proc/uptime"
	loadAvgPath = "/proc/loadavg"
)

func readUptime() (int64, error) {
	b, err := os.ReadFile(uptimePath)
	if err != nil {
		return 0, err
	}
	return parseUptime(string(b))
}

func parseUptime(content string) (int64, error) {
	fields := strings.Fields(content)
	if len(fields) < 1 {
		return 0, fmt.Errorf("empty uptime input")
	}
	secs, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, fmt.Errorf("parse uptime: %w", err)
	}
	return int64(secs + 0.5), nil
}

func readLoadAvg() (la1, la5, la15 float64, err error) {
	b, readErr := os.ReadFile(loadAvgPath)
	if readErr != nil {
		return 0, 0, 0, readErr
	}
	return parseLoadAvg(string(b))
}

func parseLoadAvg(content string) (la1, la5, la15 float64, err error) {
	fields := strings.Fields(content)
	if len(fields) < 3 {
		return 0, 0, 0, fmt.Errorf("loadavg has %d fields, need >=3", len(fields))
	}
	la1, err = strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("parse la1: %w", err)
	}
	la5, err = strconv.ParseFloat(fields[1], 64)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("parse la5: %w", err)
	}
	la15, err = strconv.ParseFloat(fields[2], 64)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("parse la15: %w", err)
	}
	return la1, la5, la15, nil
}

// readDockerVersion runs `docker --version` with a 2s timeout. Returns the
// trimmed stdout on success, "" otherwise. Best-effort by design — host_info
// must not hang or fail when docker is missing or the daemon is wedged.
func readDockerVersion() string {
	if _, err := exec.LookPath("docker"); err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func readIPAddresses() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return []string{}
	}
	return filterIPs(addrs)
}

func filterIPs(addrs []net.Addr) []string {
	out := []string{}
	for _, a := range addrs {
		var ip net.IP
		switch v := a.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		}
		if ip == nil {
			continue
		}
		v4 := ip.To4()
		if v4 == nil {
			continue
		}
		if v4.IsLoopback() || v4.IsLinkLocalUnicast() {
			continue
		}
		out = append(out, v4.String())
	}
	sort.Strings(out)
	return out
}
