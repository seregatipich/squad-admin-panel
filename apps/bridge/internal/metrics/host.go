// Package metrics reads the host's OS release, kernel, CPU, and
// utilisation stats for host_info / host_metrics RPC methods.
package metrics

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// HostInfo is the static snapshot returned by host_info.
type HostInfo struct {
	Hostname      string `json:"hostname"`
	OSName        string `json:"os_name"`
	OSVersion     string `json:"os_version"`
	Kernel        string `json:"kernel"`
	Arch          string `json:"arch"`
	CPUModel      string `json:"cpu_model"`
	CPUCores      int    `json:"cpu_cores"`
	RAMTotalBytes int64  `json:"ram_total_bytes"`
}

// HostMetrics is the live sample returned by host_metrics.
type HostMetrics struct {
	CPUPercent        float64   `json:"cpu_percent"`
	RAMUsedBytes      int64     `json:"ram_used_bytes"`
	RAMTotalBytes     int64     `json:"ram_total_bytes"`
	DiskUsedBytes     int64     `json:"disk_used_bytes"`
	DiskTotalBytes    int64     `json:"disk_total_bytes"`
	NetRxBytesPerSec  float64   `json:"net_rx_bytes_per_sec"`
	NetTxBytesPerSec  float64   `json:"net_tx_bytes_per_sec"`
	SampledAt         time.Time `json:"sampled_at"`
}

// Info returns HostInfo populated from /etc/os-release and runtime info.
func Info() (HostInfo, error) {
	hn, _ := os.Hostname()
	h := HostInfo{
		Hostname: hn,
		Arch:     runtime.GOARCH,
		CPUCores: runtime.NumCPU(),
	}
	osName, osVer := readOSRelease()
	h.OSName = osName
	h.OSVersion = osVer
	h.Kernel = readKernelVersion()
	h.CPUModel = readCPUModel()
	if mem, err := readMemTotal(); err == nil {
		h.RAMTotalBytes = mem
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
	return m, cur, nil
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
