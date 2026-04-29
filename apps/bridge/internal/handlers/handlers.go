// Package handlers wires RPC methods to the privileged subsystems.
// Every method here is responsible for:
//  1. Parsing params.
//  2. Running validate.* to reject anything out of policy.
//  3. Delegating to sysd / fsx / runner / metrics.
//  4. Building a Response.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/fsx"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/metrics"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/runner"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/sysd"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

var Version = "dev"

// restartFlushDelay is the time the host_agent_restart handler waits between
// flushing its response back over the unix socket and exec'ing systemctl. It
// is small enough that the operator perceives the restart as instant, large
// enough that the framed response reaches the client before systemd kills us.
const restartFlushDelay = 250 * time.Millisecond

type Dispatcher struct {
	UFW          *sysd.UFW
	Docker       *runner.DockerRunner
	DiskRoot     string
	MetricsCache *metrics.MetricsCache
	// RestartCommand returns the *exec.Cmd that performs the bridge daemon
	// restart. Tests inject a recorder; production leaves it nil and the
	// real systemctl invocation is used.
	RestartCommand func() *exec.Cmd
	// restartDelay overrides restartFlushDelay; tests use this to bring the
	// observation window down to a few milliseconds.
	restartDelay time.Duration
}

func (d *Dispatcher) Handle(
	ctx context.Context,
	req *rpc.Request,
	onStream func(rpc.StreamFrame),
) rpc.Response {
	switch req.Method {
	case "ping":
		return d.ping(req)
	case "host_info":
		return d.hostInfo(req)
	case "host_metrics":
		return d.hostMetrics(req)
	case "file_read":
		return d.fileRead(req)
	case "file_write":
		return d.fileWrite(req)
	case "file_atomic_write":
		return d.fileAtomicWrite(req)
	case "directory_delete":
		return d.directoryDelete(req)
	case "list_panel_dirs":
		return d.listPanelDirs(req)
	case "list_squad_containers":
		return d.listSquadContainers(ctx, req)
	case "ufw_rule":
		return d.ufwRule(ctx, req)
	case "process_info":
		return d.processInfo(req)
	case "container_run":
		return d.containerRun(ctx, req)
	case "container_start":
		return d.containerStart(ctx, req)
	case "container_stop":
		return d.containerStop(ctx, req)
	case "container_rm":
		return d.containerRm(ctx, req)
	case "container_inspect":
		return d.containerInspect(ctx, req)
	case "container_stats":
		return d.containerStats(ctx, req)
	case "container_logs_follow":
		return d.containerLogsFollow(ctx, req, onStream)
	case "depot_update":
		return d.depotUpdate(ctx, req, onStream)
	case "docker_prune":
		return d.dockerPrune(ctx, req, onStream)
	case "host_agent_restart":
		return d.hostAgentRestart(req)
	}
	return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, "unknown method: "+req.Method)
}

func (d *Dispatcher) hostAgentRestart(req *rpc.Request) rpc.Response {
	delay := d.restartDelay
	if delay <= 0 {
		delay = restartFlushDelay
	}
	cmdFactory := d.RestartCommand
	if cmdFactory == nil {
		cmdFactory = func() *exec.Cmd {
			return exec.Command("systemctl", "restart", "panel-host-bridge.service")
		}
	}
	go func() {
		time.Sleep(delay)
		cmd := cmdFactory()
		if cmd == nil {
			return
		}
		_ = cmd.Start()
	}()
	body, _ := json.Marshal(map[string]string{"status": "restarting"})
	return rpc.NewSuccessResponse(req.ID, body)
}

// --- read-only / diagnostic ---

func (d *Dispatcher) ping(req *rpc.Request) rpc.Response {
	hn, _ := os.Hostname()
	body, _ := json.Marshal(map[string]any{
		"pong":     true,
		"version":  Version,
		"hostname": hn,
	})
	return rpc.NewSuccessResponse(req.ID, body)
}

func (d *Dispatcher) hostInfo(req *rpc.Request) rpc.Response {
	info, err := metrics.Info()
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInternal, err.Error())
	}
	body, _ := json.Marshal(info)
	return rpc.NewSuccessResponse(req.ID, body)
}

func (d *Dispatcher) hostMetrics(req *rpc.Request) rpc.Response {
	mp := d.DiskRoot
	if mp == "" {
		mp = "/"
	}
	if d.MetricsCache == nil {
		d.MetricsCache = metrics.NewMetricsCache(nil, nil, 200*time.Millisecond)
	}
	body, _ := json.Marshal(d.MetricsCache.Sample(mp))
	return rpc.NewSuccessResponse(req.ID, body)
}

// --- filesystem ---

type fileReadParams struct {
	Path string `json:"path"`
}

func (d *Dispatcher) fileRead(req *rpc.Request) rpc.Response {
	var p fileReadParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if err := validateReadablePath(p.Path); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeForbidden, err.Error())
	}
	b, err := fsx.Read(p.Path)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"content": string(b)})
	return rpc.NewSuccessResponse(req.ID, body)
}

type fileWriteParams struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    uint32 `json:"mode,omitempty"`
}

func (d *Dispatcher) fileWrite(req *rpc.Request) rpc.Response {
	var p fileWriteParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if err := validateWritablePath(p.Path); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeForbidden, err.Error())
	}
	mode := os.FileMode(0o644)
	if p.Mode != 0 {
		mode = os.FileMode(p.Mode)
	}
	if err := fsx.Write(p.Path, []byte(p.Content), mode); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"status": "written"})
	return rpc.NewSuccessResponse(req.ID, body)
}

func (d *Dispatcher) fileAtomicWrite(req *rpc.Request) rpc.Response {
	var p fileWriteParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if err := validateWritablePath(p.Path); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeForbidden, err.Error())
	}
	mode := os.FileMode(0o644)
	if p.Mode != 0 {
		mode = os.FileMode(p.Mode)
	}
	if err := fsx.AtomicWrite(p.Path, []byte(p.Content), mode); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"status": "written"})
	return rpc.NewSuccessResponse(req.ID, body)
}

type directoryDeleteParams struct {
	Path string `json:"path"`
}

func (d *Dispatcher) directoryDelete(req *rpc.Request) rpc.Response {
	var p directoryDeleteParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	cleaned, err := validateDeletableDir(p.Path)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeForbidden, err.Error())
	}
	if _, statErr := os.Stat(cleaned); errors.Is(statErr, fs.ErrNotExist) {
		body, _ := json.Marshal(map[string]bool{"removed": false})
		return rpc.NewSuccessResponse(req.ID, body)
	}
	if err := os.RemoveAll(cleaned); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	body, _ := json.Marshal(map[string]bool{"removed": true})
	return rpc.NewSuccessResponse(req.ID, body)
}

func validateDeletableDir(p string) (string, error) {
	if cleaned, err := validate.PanelConfigsServerRoot(p); err == nil {
		return cleaned, nil
	}
	if cleaned, err := validate.PanelSavedServerRoot(p); err == nil {
		return cleaned, nil
	}
	return "", fmt.Errorf("%w: directory_delete only allows %s/{uuid} or %s/{uuid}", validate.ErrForbidden, validate.PanelConfigsRoot, validate.PanelSavedRoot)
}

// listSquadContainers returns the names of every container matching
// `squad-{uuid}`. The API uses this to detect orphan running containers
// whose UUID has no row in the `servers` DB and stop+rm them.
func (d *Dispatcher) listSquadContainers(ctx context.Context, req *rpc.Request) rpc.Response {
	names, err := d.Docker.ListSquadContainers(ctx)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	body, _ := json.Marshal(map[string][]string{"containers": names})
	return rpc.NewSuccessResponse(req.ID, body)
}

// listPanelDirs returns the immediate child directory names of the two
// allowlisted panel roots. Read-only, no path traversal — callers cannot
// pass a path; the roots are hard-coded constants. Used by the API to
// detect orphan directories whose UUID is no longer present in the DB.
func (d *Dispatcher) listPanelDirs(req *rpc.Request) rpc.Response {
	configs, err := readImmediateDirs(validate.PanelConfigsRoot)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, "configs: "+err.Error())
	}
	saved, err := readImmediateDirs(validate.PanelSavedRoot)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, "saved: "+err.Error())
	}
	body, _ := json.Marshal(map[string][]string{"configs": configs, "saved": saved})
	return rpc.NewSuccessResponse(req.ID, body)
}

func readImmediateDirs(root string) ([]string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []string{}, nil
		}
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		out = append(out, e.Name())
	}
	return out, nil
}

// Accept: any config file under /var/lib/squad-panel/configs/{uuid}/ServerConfig/,
// any file under /var/lib/squad-panel/saved/{uuid}/ (Squad logs etc.),
// and read-only access to the squad-depot volume's on-disk location so the
// install flow can seed a new server's configs from depot defaults. The
// depot root is configurable via PANEL_DEPOT_HOST_PATH (see fsx.DepotHostPath);
// for bind-mounted squad-depot volumes Docker does NOT populate the
// /var/lib/docker/volumes/squad-depot/_data stub, so the operator must set
// the env var to the bind-mount source directly.
func validateReadablePath(p string) error {
	if _, err := validate.PanelConfigFilePath(p); err == nil {
		return nil
	}
	if _, err := validate.PanelSavedPath(p); err == nil {
		return nil
	}
	if _, err := validate.Path(p, fsx.DepotHostPath()); err == nil {
		return nil
	}
	if _, err := validate.PanelSentinelPath(p); err == nil {
		return nil
	}
	return fmt.Errorf("%w: path %q not in readable allowlist", validate.ErrForbidden, p)
}

func validateWritablePath(p string) error {
	if _, err := validate.PanelConfigFilePath(p); err == nil {
		return nil
	}
	if _, err := validate.PanelSentinelPath(p); err == nil {
		return nil
	}
	return fmt.Errorf("%w: path %q not in writable allowlist", validate.ErrForbidden, p)
}

// --- firewall ---

type ufwParams struct {
	Action  string `json:"action"`
	Port    int    `json:"port"`
	Proto   string `json:"proto"`
	Comment string `json:"comment,omitempty"`
}

func (d *Dispatcher) ufwRule(ctx context.Context, req *rpc.Request) rpc.Response {
	var p ufwParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	out, err := d.UFW.Rule(ctx, p.Action, p.Proto, p.Port, p.Comment)
	if err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"output": out, "status": "done"})
	return rpc.NewSuccessResponse(req.ID, body)
}

// --- container lifecycle ---

type containerRunParams struct {
	ServerID     string   `json:"server_id"`
	Image        string   `json:"image"`
	GamePort     int      `json:"game_port"`
	QueryPort    int      `json:"query_port"`
	BeaconPort   int      `json:"beacon_port"`
	RCONPort     int      `json:"rcon_port"`
	MaxPlayers   int      `json:"max_players,omitempty"`
	Tickrate     int      `json:"tickrate,omitempty"`
	Multihome    string   `json:"multihome,omitempty"`
	ExtraArgs    []string `json:"extra_args,omitempty"`
	ConfigsHost  string   `json:"configs_host"`
	SavedHost    string   `json:"saved_host"`
	DepotVolume  string   `json:"depot_volume"`
	UlimitNofile int      `json:"ulimit_nofile,omitempty"`
}

func (d *Dispatcher) containerRun(ctx context.Context, req *rpc.Request) rpc.Response {
	var p containerRunParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	id, err := d.Docker.Run(ctx, runner.ContainerRunSpec{
		ServerID:     p.ServerID,
		Image:        p.Image,
		GamePort:     p.GamePort,
		QueryPort:    p.QueryPort,
		BeaconPort:   p.BeaconPort,
		RCONPort:     p.RCONPort,
		MaxPlayers:   p.MaxPlayers,
		Tickrate:     p.Tickrate,
		Multihome:    p.Multihome,
		ExtraArgs:    p.ExtraArgs,
		ConfigsHost:  p.ConfigsHost,
		SavedHost:    p.SavedHost,
		DepotVolume:  p.DepotVolume,
		UlimitNofile: p.UlimitNofile,
	})
	if err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"container_id": id, "status": "started"})
	return rpc.NewSuccessResponse(req.ID, body)
}

type containerParams struct {
	Name       string `json:"name"`
	TimeoutSec int    `json:"timeout_sec,omitempty"`
}

func (d *Dispatcher) containerStart(ctx context.Context, req *rpc.Request) rpc.Response {
	var p containerParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if err := d.Docker.Start(ctx, p.Name); err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"status": "started"})
	return rpc.NewSuccessResponse(req.ID, body)
}

func (d *Dispatcher) containerStop(ctx context.Context, req *rpc.Request) rpc.Response {
	var p containerParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	dur := time.Duration(p.TimeoutSec) * time.Second
	if err := d.Docker.Stop(ctx, p.Name, dur); err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"status": "stopped"})
	return rpc.NewSuccessResponse(req.ID, body)
}

func (d *Dispatcher) containerRm(ctx context.Context, req *rpc.Request) rpc.Response {
	var p containerParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if err := d.Docker.Rm(ctx, p.Name); err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"status": "removed"})
	return rpc.NewSuccessResponse(req.ID, body)
}

func (d *Dispatcher) containerInspect(ctx context.Context, req *rpc.Request) rpc.Response {
	var p containerParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	res, err := d.Docker.Inspect(ctx, p.Name)
	if err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
	}
	body, _ := json.Marshal(res)
	return rpc.NewSuccessResponse(req.ID, body)
}

func (d *Dispatcher) containerStats(ctx context.Context, req *rpc.Request) rpc.Response {
	var p containerParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	res, err := d.Docker.Stats(ctx, p.Name)
	if err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
	}
	body, _ := json.Marshal(res)
	return rpc.NewSuccessResponse(req.ID, body)
}

type containerLogsParams struct {
	Name string `json:"name"`
	Tail int    `json:"tail,omitempty"`
}

func (d *Dispatcher) containerLogsFollow(
	ctx context.Context,
	req *rpc.Request,
	onStream func(rpc.StreamFrame),
) rpc.Response {
	var p containerLogsParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	push := func(stream string) func([]byte) {
		return func(chunk []byte) {
			raw, _ := json.Marshal(string(chunk))
			onStream(rpc.StreamFrame{ID: req.ID, Stream: stream, Data: raw})
		}
	}
	exit, err := d.Docker.LogsFollow(ctx, p.Name, p.Tail, push("stdout"), push("stderr"))
	if err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
	}
	body, _ := json.Marshal(map[string]int{"exit_code": exit})
	return rpc.NewSuccessResponse(req.ID, body)
}

func (d *Dispatcher) depotUpdate(
	ctx context.Context,
	req *rpc.Request,
	onStream func(rpc.StreamFrame),
) rpc.Response {
	push := func(stream string) func([]byte) {
		return func(chunk []byte) {
			raw, _ := json.Marshal(string(chunk))
			onStream(rpc.StreamFrame{ID: req.ID, Stream: stream, Data: raw})
		}
	}
	exit, err := d.Docker.DepotUpdate(ctx, push("stdout"), push("stderr"))
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	body, _ := json.Marshal(map[string]int{"exit_code": exit})
	return rpc.NewSuccessResponse(req.ID, body)
}

// dockerPrune runs `docker system prune -af` and streams progress.
// Volumes are NOT pruned (the squad-depot volume + server data must
// survive). Caller (the API) parses the trailing "Total reclaimed
// space:" line from stdout for the final freed-bytes figure.
func (d *Dispatcher) dockerPrune(
	ctx context.Context,
	req *rpc.Request,
	onStream func(rpc.StreamFrame),
) rpc.Response {
	var stdoutBuf, stderrBuf strings.Builder
	push := func(stream string, sink *strings.Builder) func([]byte) {
		return func(chunk []byte) {
			sink.Write(chunk)
			raw, _ := json.Marshal(string(chunk))
			onStream(rpc.StreamFrame{ID: req.ID, Stream: stream, Data: raw})
		}
	}
	exit, err := d.Docker.SystemPrune(ctx, push("stdout", &stdoutBuf), push("stderr", &stderrBuf))
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	reclaimed := parseReclaimed(stdoutBuf.String())
	body, _ := json.Marshal(map[string]any{
		"exit_code":       exit,
		"reclaimed_bytes": reclaimed,
		"reclaimed_human": humanReclaimed(stdoutBuf.String()),
	})
	return rpc.NewSuccessResponse(req.ID, body)
}

// parseReclaimed extracts the byte count from docker's "Total reclaimed
// space: 146.9GB" trailing line, returning 0 if not found.
func parseReclaimed(s string) int64 {
	const marker = "Total reclaimed space:"
	idx := strings.LastIndex(s, marker)
	if idx < 0 {
		return 0
	}
	tail := strings.TrimSpace(s[idx+len(marker):])
	// take just the first whitespace-separated field
	if i := strings.IndexAny(tail, " \t\r\n"); i >= 0 {
		tail = tail[:i]
	}
	return parseHumanSize(tail)
}

func humanReclaimed(s string) string {
	const marker = "Total reclaimed space:"
	idx := strings.LastIndex(s, marker)
	if idx < 0 {
		return ""
	}
	tail := strings.TrimSpace(s[idx+len(marker):])
	if i := strings.IndexAny(tail, "\r\n"); i >= 0 {
		tail = tail[:i]
	}
	return strings.TrimSpace(tail)
}

// parseHumanSize parses docker's "146.9GB" / "256MB" / "0B" notation.
// Returns 0 on parse failure.
func parseHumanSize(s string) int64 {
	if s == "" {
		return 0
	}
	units := map[string]float64{
		"B":  1,
		"KB": 1 << 10, "K": 1 << 10,
		"MB": 1 << 20, "M": 1 << 20,
		"GB": 1 << 30, "G": 1 << 30,
		"TB": 1 << 40, "T": 1 << 40,
		"KiB": 1 << 10,
		"MiB": 1 << 20,
		"GiB": 1 << 30,
		"TiB": 1 << 40,
	}
	for _, suf := range []string{"TiB", "GiB", "MiB", "KiB", "TB", "GB", "MB", "KB", "T", "G", "M", "K", "B"} {
		if strings.HasSuffix(s, suf) {
			numStr := strings.TrimSuffix(s, suf)
			var n float64
			_, err := fmt.Sscanf(numStr, "%f", &n)
			if err != nil {
				return 0
			}
			return int64(n * units[suf])
		}
	}
	return 0
}

// --- process inspection ---

type processInfoParams struct {
	PID int `json:"pid"`
}

type processInfoResult struct {
	PID      int    `json:"pid"`
	Exists   bool   `json:"exists"`
	RSSBytes int64  `json:"rss_bytes,omitempty"`
	VSZBytes int64  `json:"vsz_bytes,omitempty"`
	Cmdline  string `json:"cmdline,omitempty"`
	State    string `json:"state,omitempty"`
	Threads  int    `json:"threads,omitempty"`
}

func (d *Dispatcher) processInfo(req *rpc.Request) rpc.Response {
	var p processInfoParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if p.PID <= 0 {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, "pid must be > 0")
	}
	res := processInfoResult{PID: p.PID}
	if _, err := os.Stat(fmt.Sprintf("/proc/%d", p.PID)); os.IsNotExist(err) {
		body, _ := json.Marshal(res)
		return rpc.NewSuccessResponse(req.ID, body)
	}
	res.Exists = true
	if cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", p.PID)); err == nil {
		res.Cmdline = strings.ReplaceAll(strings.TrimRight(string(cmdline), "\x00"), "\x00", " ")
	}
	if status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", p.PID)); err == nil {
		for _, line := range strings.Split(string(status), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			switch fields[0] {
			case "State:":
				res.State = strings.Join(fields[1:], " ")
			case "Threads:":
				fmt.Sscanf(fields[1], "%d", &res.Threads)
			case "VmRSS:":
				var kb int64
				fmt.Sscanf(fields[1], "%d", &kb)
				res.RSSBytes = kb * 1024
			case "VmSize:":
				var kb int64
				fmt.Sscanf(fields[1], "%d", &kb)
				res.VSZBytes = kb * 1024
			}
		}
	}
	body, _ := json.Marshal(res)
	return rpc.NewSuccessResponse(req.ID, body)
}

func isForbidden(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "forbidden")
}
