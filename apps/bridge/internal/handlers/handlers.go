// Package handlers wires RPC methods to the privileged subsystems.
// Every method here is responsible for:
//  1. Parsing params.
//  2. Running validate.* to reject anything out of policy.
//  3. Delegating to sysd / fsx / runner / metrics.
//  4. Building a Response.
package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/fsx"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/metrics"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/runner"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/sysd"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

// DiagSink is the io.Writer that diagLog writes structured JSON lines to. It
// defaults to os.Stderr (captured by systemd into the journal) and tests swap
// it for a buffer to assert the wire format.
var DiagSink io.Writer = os.Stderr

// DiagLog writes a single structured journal line that the worker-diag-flush
// journald forwarder picks up. We intentionally write to stderr (journald-
// captured) instead of touching Redis from the privileged daemon — keeps the
// attack surface minimal. Payload keys are merged into the top-level record so
// they appear flat in the journald JSON view.
func DiagLog(component, kind, severity, message string, payload map[string]any) {
	rec := map[string]any{
		"DIAG_EVENT": "1",
		"component":  component,
		"kind":       kind,
		"severity":   severity,
		"message":    message,
		"ts":         time.Now().UTC().Format(time.RFC3339),
	}
	for k, v := range payload {
		if _, reserved := rec[k]; reserved {
			continue
		}
		rec[k] = v
	}
	b, err := json.Marshal(rec)
	if err != nil {
		return
	}
	fmt.Fprintln(DiagSink, string(b))
}

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

	// panelRoot overrides the panel data root (production default
	// /var/lib/squad-panel) for panel_disk_usage. Tests inject a t.TempDir.
	panelRoot string
	// duFn measures bytes used at a path. Tests stub it; production uses du -sb.
	duFn func(path string) (int64, error)
	// statfsFn samples the filesystem at a path. Tests stub it; production uses syscall.Statfs.
	statfsFn func(path string, st *syscall.Statfs_t) error
	// dockerDfFn returns panel-owned volumes/images and the squad-depot byte total.
	// Tests stub it; production shells out to `docker system df --format '{{json .}}' -v`.
	dockerDfFn func() ([]dockerVol, []dockerImg, int64, error)
}

func (d *Dispatcher) Handle(
	ctx context.Context,
	req *rpc.Request,
	onStream func(rpc.StreamFrame),
) (resp rpc.Response) {
	defer func() {
		if r := recover(); r != nil {
			DiagLog("bridge", "bridge.panic", "fatal", fmt.Sprintf("dispatcher panic: %v", r), map[string]any{
				"method":     req.Method,
				"request_id": req.ID,
				"recovered":  fmt.Sprintf("%v", r),
			})
			resp = rpc.NewErrorResponse(req.ID, rpc.CodeInternal, fmt.Sprintf("dispatcher panic: %v", r))
		}
	}()
	switch req.Method {
	case "ping":
		return d.ping(req)
	case "host_info":
		return d.hostInfo(req)
	case "host_metrics":
		return d.hostMetrics(req)
	case "file_read":
		return d.fileRead(req)
	case "file_read_tail":
		return d.fileReadTail(req)
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
	case "panel_disk_usage":
		return d.panelDiskUsage(req)
	case "host_agent_restart":
		return d.hostAgentRestart(req)
	}
	return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, "unknown method: "+req.Method)
}

func (d *Dispatcher) hostAgentRestart(req *rpc.Request) rpc.Response {
	DiagLog("bridge", "bridge.host_agent_restart", "info", "host_agent_restart invoked", map[string]any{
		"request_id": req.ID,
	})
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

const (
	fileReadTailDefaultMaxBytes int64 = 64 * 1024
	fileReadTailMaxAllowedBytes int64 = 1 << 20
)

type fileReadTailParams struct {
	Path     string `json:"path"`
	MaxBytes int64  `json:"max_bytes"`
}

func (d *Dispatcher) fileReadTail(req *rpc.Request) rpc.Response {
	var p fileReadTailParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if err := validateReadablePath(p.Path); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeForbidden, err.Error())
	}
	maxBytes := p.MaxBytes
	if maxBytes <= 0 {
		maxBytes = fileReadTailDefaultMaxBytes
	} else if maxBytes > fileReadTailMaxAllowedBytes {
		maxBytes = fileReadTailMaxAllowedBytes
	}
	f, err := os.Open(p.Path)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	size := st.Size()
	var off int64
	if size > maxBytes {
		off = size - maxBytes
	}
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	buf := make([]byte, size-off)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	start := 0
	if off > 0 {
		if i := bytes.IndexByte(buf[:n], '\n'); i >= 0 {
			start = i + 1
		}
	}
	body, _ := json.Marshal(map[string]any{
		"content":   string(buf[start:n]),
		"offset":    off + int64(start),
		"size":      size,
		"truncated": off > 0,
	})
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
	n, _ := parseHumanSize(tail)
	return n
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

// parseHumanSize is defined later in this file (the feat-branch variant
// returning (int64, error)). The reclaimed-space parser above wraps it.

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

// --- panel disk usage ---

type savedEntry struct {
	UUID  string `json:"uuid"`
	Bytes int64  `json:"bytes"`
}

type dockerVol struct {
	Name  string `json:"name"`
	Bytes int64  `json:"bytes"`
}

type dockerImg struct {
	Repository string `json:"repository"`
	Tag        string `json:"tag"`
	Bytes      int64  `json:"bytes"`
}

type panelDiskUsageResult struct {
	ConfigsBytes      int64        `json:"configs_bytes"`
	SavedTotalBytes   int64        `json:"saved_total_bytes"`
	SavedPerServer    []savedEntry `json:"saved_per_server"`
	DepotVolumeBytes  int64        `json:"depot_volume_bytes"`
	DockerVolumes     []dockerVol  `json:"docker_volumes"`
	DockerImages      []dockerImg  `json:"docker_images"`
	AuditArchiveBytes int64        `json:"audit_archive_bytes"`
	TotalPanelBytes   int64        `json:"total_panel_bytes"`
	HostTotalBytes    int64        `json:"host_total_bytes"`
	HostUsedBytes     int64        `json:"host_used_bytes"`
	ComputedAt        string       `json:"computed_at"`
	CacheAgeSeconds   int          `json:"cache_age_seconds"`
}

const (
	defaultPanelRoot  = "/var/lib/squad-panel"
	panelDiskCacheTTL = 5 * time.Minute
	depotVolumeName   = "squad-depot"
	pgDataVolumeName  = "squad-panel_pg-data"
	redisVolumeName   = "squad-panel_redis-data"
)

var panelOwnedImages = map[string]struct{}{
	"squad-server":           {},
	"squad-panel/depot-init": {},
	"squad-panel/api":        {},
	"squad-panel/web":        {},
	"squad-panel/worker":     {},
}

var panelOwnedVolumes = map[string]struct{}{
	depotVolumeName:  {},
	pgDataVolumeName: {},
	redisVolumeName:  {},
}

var (
	panelDiskCacheMu     sync.Mutex
	panelDiskCacheVal    *panelDiskUsageResult
	panelDiskCacheStored time.Time
)

func resetPanelDiskUsageCache() {
	panelDiskCacheMu.Lock()
	panelDiskCacheVal = nil
	panelDiskCacheStored = time.Time{}
	panelDiskCacheMu.Unlock()
}

func realDuBytes(path string) (int64, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	out, err := exec.Command("du", "-sb", path).Output()
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return 0, fmt.Errorf("du produced no output for %q", path)
	}
	n, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse du output %q: %w", fields[0], err)
	}
	return n, nil
}

func realStatfs(path string, st *syscall.Statfs_t) error {
	return syscall.Statfs(path, st)
}

// parseHumanSize parses a human-readable byte string like "1.2GB", "512MB", "0B"
// produced by `docker system df --format '{{json .}}'`. Returns 0 on empty input.
func parseHumanSize(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" || s == "0" || s == "0B" {
		return 0, nil
	}
	suffixes := []struct {
		unit  string
		scale float64
	}{
		{"TB", 1 << 40},
		{"GB", 1 << 30},
		{"MB", 1 << 20},
		{"kB", 1 << 10},
		{"KB", 1 << 10},
		{"B", 1},
	}
	for _, suffix := range suffixes {
		if strings.HasSuffix(s, suffix.unit) {
			num := strings.TrimSpace(strings.TrimSuffix(s, suffix.unit))
			val, err := strconv.ParseFloat(num, 64)
			if err != nil {
				return 0, fmt.Errorf("parse human size %q: %w", s, err)
			}
			return int64(val * suffix.scale), nil
		}
	}
	val, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("unrecognized size format %q", s)
	}
	return val, nil
}

func realDockerDiskBreakdown() ([]dockerVol, []dockerImg, int64, error) {
	out, err := exec.Command("docker", "system", "df", "--format", "{{json .}}", "-v").Output()
	if err != nil {
		return nil, nil, 0, fmt.Errorf("docker system df: %w", err)
	}
	volumes := []dockerVol{}
	images := []dockerImg{}
	var depotBytes int64
	for _, line := range bytes.Split(out, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			continue
		}
		if name, ok := record["Name"].(string); ok && name != "" {
			if _, owned := panelOwnedVolumes[name]; !owned {
				continue
			}
			sizeStr, _ := record["Size"].(string)
			size, err := parseHumanSize(sizeStr)
			if err != nil {
				return nil, nil, 0, err
			}
			volumes = append(volumes, dockerVol{Name: name, Bytes: size})
			if name == depotVolumeName {
				depotBytes = size
			}
			continue
		}
		if repo, ok := record["Repository"].(string); ok && repo != "" {
			if _, owned := panelOwnedImages[repo]; !owned {
				continue
			}
			tag, _ := record["Tag"].(string)
			sizeStr, _ := record["Size"].(string)
			size, err := parseHumanSize(sizeStr)
			if err != nil {
				return nil, nil, 0, err
			}
			images = append(images, dockerImg{Repository: repo, Tag: tag, Bytes: size})
		}
	}
	return volumes, images, depotBytes, nil
}

func (d *Dispatcher) panelDiskUsage(req *rpc.Request) rpc.Response {
	var params struct {
		Force bool `json:"force,omitempty"`
	}
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, fmt.Sprintf("decode params: %v", err))
		}
	}

	panelDiskCacheMu.Lock()
	defer panelDiskCacheMu.Unlock()

	if !params.Force && panelDiskCacheVal != nil && time.Since(panelDiskCacheStored) < panelDiskCacheTTL {
		cached := *panelDiskCacheVal
		cached.CacheAgeSeconds = int(time.Since(panelDiskCacheStored).Seconds())
		body, _ := json.Marshal(&cached)
		return rpc.NewSuccessResponse(req.ID, body)
	}

	root := d.panelRoot
	if root == "" {
		root = defaultPanelRoot
	}
	du := d.duFn
	if du == nil {
		du = realDuBytes
	}
	statfs := d.statfsFn
	if statfs == nil {
		statfs = realStatfs
	}
	dockerDf := d.dockerDfFn
	if dockerDf == nil {
		dockerDf = realDockerDiskBreakdown
	}

	configsBytes, err := du(filepath.Join(root, "configs"))
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, fmt.Sprintf("du configs: %v", err))
	}
	savedRoot := filepath.Join(root, "saved")
	savedTotal, err := du(savedRoot)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, fmt.Sprintf("du saved: %v", err))
	}
	auditBytes, err := du(filepath.Join(root, "audit-archive"))
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, fmt.Sprintf("du audit-archive: %v", err))
	}

	savedDirs, err := readImmediateDirs(savedRoot)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, fmt.Sprintf("read saved: %v", err))
	}
	savedPerServer := make([]savedEntry, 0, len(savedDirs))
	for _, name := range savedDirs {
		size, err := du(filepath.Join(savedRoot, name))
		if err != nil {
			return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, fmt.Sprintf("du saved/%s: %v", name, err))
		}
		savedPerServer = append(savedPerServer, savedEntry{UUID: name, Bytes: size})
	}

	dockerVolumes, dockerImages, depotBytes, err := dockerDf()
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	if dockerVolumes == nil {
		dockerVolumes = []dockerVol{}
	}
	if dockerImages == nil {
		dockerImages = []dockerImg{}
	}

	statfsTarget := root
	if _, statErr := os.Stat(root); statErr != nil && os.IsNotExist(statErr) {
		statfsTarget = filepath.Dir(root)
	}
	var st syscall.Statfs_t
	if err := statfs(statfsTarget, &st); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, fmt.Sprintf("statfs %s: %v", statfsTarget, err))
	}
	hostTotal := int64(st.Blocks) * int64(st.Bsize)
	hostUsed := int64(st.Blocks-st.Bavail) * int64(st.Bsize)

	total := configsBytes + savedTotal + auditBytes
	for _, v := range dockerVolumes {
		total += v.Bytes
	}
	for _, im := range dockerImages {
		total += im.Bytes
	}

	res := panelDiskUsageResult{
		ConfigsBytes:      configsBytes,
		SavedTotalBytes:   savedTotal,
		SavedPerServer:    savedPerServer,
		DepotVolumeBytes:  depotBytes,
		DockerVolumes:     dockerVolumes,
		DockerImages:      dockerImages,
		AuditArchiveBytes: auditBytes,
		TotalPanelBytes:   total,
		HostTotalBytes:    hostTotal,
		HostUsedBytes:     hostUsed,
		ComputedAt:        time.Now().UTC().Format(time.RFC3339),
		CacheAgeSeconds:   0,
	}

	cached := res
	panelDiskCacheVal = &cached
	panelDiskCacheStored = time.Now()

	body, _ := json.Marshal(&res)
	return rpc.NewSuccessResponse(req.ID, body)
}
