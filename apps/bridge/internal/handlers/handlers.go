// Package handlers wires RPC methods to the privileged subsystems.
// Every method here is responsible for:
//   1. Parsing params.
//   2. Running validate.* to reject anything out of policy.
//   3. Delegating to sysd / fsx / runner / metrics.
//   4. Building a Response.
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
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

type Dispatcher struct {
	UFW      *sysd.UFW
	Docker   *runner.DockerRunner
	DiskRoot string
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
	case "ufw_rule":
		return d.ufwRule(ctx, req)
	case "process_info":
		return d.processInfo(req)
	case "container_run":
		return d.containerRun(ctx, req)
	case "container_run_rnsquadjs":
		return d.containerRunRnsquadjs(ctx, req)
	case "container_start":
		return d.containerStart(ctx, req)
	case "container_stop":
		return d.containerStop(ctx, req)
	case "container_rm":
		return d.containerRm(ctx, req)
	case "container_inspect":
		return d.containerInspect(ctx, req)
	case "container_logs_follow":
		return d.containerLogsFollow(ctx, req, onStream)
	case "depot_update":
		return d.depotUpdate(ctx, req, onStream)
	}
	return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, "unknown method: "+req.Method)
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
	_, prev, err := metrics.Metrics(nil, mp)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInternal, err.Error())
	}
	after, _, err := metrics.Metrics(prev, mp)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInternal, err.Error())
	}
	body, _ := json.Marshal(after)
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
	return fmt.Errorf("%w: path %q not in readable allowlist", validate.ErrForbidden, p)
}

func validateWritablePath(p string) error {
	if _, err := validate.PanelConfigFilePath(p); err == nil {
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

type containerRunRnsquadjsParams struct {
	ServerID string            `json:"server_id"`
	Env      map[string]string `json:"env"`
}

func (d *Dispatcher) containerRunRnsquadjs(ctx context.Context, req *rpc.Request) rpc.Response {
	var p containerRunRnsquadjsParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	id, err := d.Docker.RunRNSquadJS(ctx, runner.RNSquadJSRunSpec{ServerID: p.ServerID, Env: p.Env})
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
