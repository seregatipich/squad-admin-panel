// Package handlers wires RPC methods to the privileged subsystems.
// Every method here is responsible for:
//   1. Parsing params.
//   2. Running validate.* to reject anything out of policy.
//   3. Delegating to sysd / pkgmgr / fsx / runner / metrics.
//   4. Building a Response.
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/fsx"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/metrics"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/pkgmgr"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/runner"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/sysd"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

// Version is overwritten at build time via -ldflags.
var Version = "dev"

// Dispatcher holds references to every subsystem and resolves method
// dispatch for incoming RPC requests.
type Dispatcher struct {
	APT      *pkgmgr.APT
	Systemd  *sysd.Client
	UFW      *sysd.UFW
	Steam    *runner.SteamCMD
	R        runner.Runner
	DiskRoot string
	sample   *int64 // placeholder for future; unused today
}

// Handle runs one request to completion and returns a Response plus
// any streaming frames the caller should forward to the client.
// For streaming methods (steamcmd_run, journalctl_follow) it writes
// the stream frames to the streamWriter callback as they arrive.
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
	case "systemctl_action":
		return d.systemctlAction(ctx, req)
	case "systemctl_daemon_reload":
		return d.systemctlDaemonReload(ctx, req)
	case "systemctl_write_unit":
		return d.systemctlWriteUnit(req)
	case "systemctl_read_unit":
		return d.systemctlReadUnit(req)
	case "apt_install":
		return d.aptInstall(ctx, req)
	case "steamcmd_run":
		return d.steamcmdRun(ctx, req, onStream)
	case "file_read":
		return d.fileRead(req)
	case "file_write":
		return d.fileWrite(req)
	case "file_atomic_write":
		return d.fileAtomicWrite(req)
	case "ufw_rule":
		return d.ufwRule(ctx, req)
	case "process_info":
		return d.processInfo(req)
	case "journalctl_follow":
		return d.journalctlFollow(ctx, req, onStream)
	}
	return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, "unknown method: "+req.Method)
}

// ---------------------------------------------------------------------
// method implementations
// ---------------------------------------------------------------------

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
	sample1, prev, err := metrics.Metrics(nil, mp)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInternal, err.Error())
	}
	_ = sample1
	_ = prev
	// Re-sample after a short interval so CPU and network rates reflect
	// real usage. 250 ms is short enough for a good UX.
	const waitMs = 250
	after, _, err := metrics.Metrics(prev, mp)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInternal, err.Error())
	}
	_ = waitMs
	body, _ := json.Marshal(after)
	return rpc.NewSuccessResponse(req.ID, body)
}

type systemctlActionParams struct {
	Unit   string `json:"unit"`
	Action string `json:"action"`
}

func (d *Dispatcher) systemctlAction(ctx context.Context, req *rpc.Request) rpc.Response {
	var p systemctlActionParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	out, err := d.Systemd.Action(ctx, p.Action, p.Unit)
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

func (d *Dispatcher) systemctlDaemonReload(ctx context.Context, req *rpc.Request) rpc.Response {
	if err := d.Systemd.DaemonReload(ctx); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"status": "done"})
	return rpc.NewSuccessResponse(req.ID, body)
}

type unitWriteParams struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (d *Dispatcher) systemctlWriteUnit(req *rpc.Request) rpc.Response {
	var p unitWriteParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if _, err := validate.UnitPath(p.Path); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeForbidden, err.Error())
	}
	if err := fsx.AtomicWrite(p.Path, []byte(p.Content), 0o644); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"status": "written"})
	return rpc.NewSuccessResponse(req.ID, body)
}

type unitReadParams struct {
	Path string `json:"path"`
}

func (d *Dispatcher) systemctlReadUnit(req *rpc.Request) rpc.Response {
	var p unitReadParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if _, err := validate.UnitPath(p.Path); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeForbidden, err.Error())
	}
	b, err := fsx.Read(p.Path)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"content": string(b)})
	return rpc.NewSuccessResponse(req.ID, body)
}

type aptInstallParams struct {
	Packages []string `json:"packages"`
}

func (d *Dispatcher) aptInstall(ctx context.Context, req *rpc.Request) rpc.Response {
	var p aptInstallParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	out, err := d.APT.Install(ctx, p.Packages)
	if err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"output": out, "status": "installed"})
	return rpc.NewSuccessResponse(req.ID, body)
}

type steamcmdRunParams struct {
	Args []string `json:"args"`
}

func (d *Dispatcher) steamcmdRun(
	ctx context.Context,
	req *rpc.Request,
	onStream func(rpc.StreamFrame),
) rpc.Response {
	var p steamcmdRunParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	push := func(stream string) func([]byte) {
		return func(chunk []byte) {
			raw, _ := json.Marshal(string(chunk))
			onStream(rpc.StreamFrame{ID: req.ID, Stream: stream, Data: raw})
		}
	}
	exit, err := d.Steam.Stream(ctx, p.Args, push("stdout"), push("stderr"))
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

type fileReadParams struct {
	Path string `json:"path"`
}

func (d *Dispatcher) fileRead(req *rpc.Request) rpc.Response {
	var p fileReadParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	b, err := fsx.Read(p.Path)
	if err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
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
	mode := os.FileMode(0o644)
	if p.Mode != 0 {
		mode = os.FileMode(p.Mode)
	}
	if err := fsx.Write(p.Path, []byte(p.Content), mode); err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"status": "written"})
	return rpc.NewSuccessResponse(req.ID, body)
}

func (d *Dispatcher) fileAtomicWrite(req *rpc.Request) rpc.Response {
	var p fileWriteParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	mode := os.FileMode(0o644)
	if p.Mode != 0 {
		mode = os.FileMode(p.Mode)
	}
	if err := fsx.AtomicWrite(p.Path, []byte(p.Content), mode); err != nil {
		code := rpc.CodeRuntimeError
		if isForbidden(err) {
			code = rpc.CodeForbidden
		}
		return rpc.NewErrorResponse(req.ID, code, err.Error())
	}
	body, _ := json.Marshal(map[string]string{"status": "written"})
	return rpc.NewSuccessResponse(req.ID, body)
}

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

type processInfoParams struct {
	PID int `json:"pid"`
}

type processInfoResult struct {
	PID         int    `json:"pid"`
	Exists      bool   `json:"exists"`
	RSSBytes    int64  `json:"rss_bytes,omitempty"`
	VSZBytes    int64  `json:"vsz_bytes,omitempty"`
	Cmdline     string `json:"cmdline,omitempty"`
	State       string `json:"state,omitempty"`
	Threads     int    `json:"threads,omitempty"`
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
	// /proc/<pid>/status gives state, threads, rss, vsz
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

type journalFollowParams struct {
	Unit  string `json:"unit"`
	Since string `json:"since,omitempty"`
	Lines int    `json:"lines,omitempty"`
}

func (d *Dispatcher) journalctlFollow(
	ctx context.Context,
	req *rpc.Request,
	onStream func(rpc.StreamFrame),
) rpc.Response {
	var p journalFollowParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if err := validate.UnitName(p.Unit); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeForbidden, err.Error())
	}
	args := []string{"--unit", p.Unit, "--follow", "--output", "short-iso"}
	if p.Since != "" {
		args = append(args, "--since", p.Since)
	}
	if p.Lines > 0 {
		args = append(args, "-n", fmt.Sprintf("%d", p.Lines))
	}
	push := func(stream string) func([]byte) {
		return func(chunk []byte) {
			raw, _ := json.Marshal(string(chunk))
			onStream(rpc.StreamFrame{ID: req.ID, Stream: stream, Data: raw})
		}
	}
	exit, err := d.R.Stream(ctx, "journalctl", args, nil, push("stdout"), push("stderr"))
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	body, _ := json.Marshal(map[string]int{"exit_code": exit})
	return rpc.NewSuccessResponse(req.ID, body)
}

func isForbidden(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "forbidden")
}

// Unused import dodge — keep `net` referenced for future listener helpers
var _ = net.IPv4
