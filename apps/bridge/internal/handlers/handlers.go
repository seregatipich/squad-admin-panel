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
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/fsx"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/metrics"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/runner"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/sysd"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/validate"
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
	// panelSavedRoot overrides the saved root for squad log retention tests.
	// Production uses validate.PanelSavedRoot and never accepts it from RPC params.
	panelSavedRoot string
	// backupDumpRoot is the host path of the restic backup staging tree
	// (${DATA_DIR}/backup-dump, snapshotted via RESTIC_BACKUP_SOURCES=/data —
	// see INFRA-8). LOG-3 (#51) copies a flagged server's expiring rotated log
	// under <backupDumpRoot>/log-archive/<serverID>/ before deleting it. Empty
	// falls back to the PANEL_BACKUP_DUMP_ROOT env var; it is never accepted
	// from RPC params. Tests inject a t.TempDir.
	backupDumpRoot string
	// nowFn overrides the clock for retention tests.
	nowFn func() time.Time
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
	case "file_read_stream":
		return d.fileReadStream(req, onStream)
	case "file_write":
		return d.fileWrite(req)
	case "file_atomic_write":
		return d.fileAtomicWrite(req)
	case "directory_delete":
		return d.directoryDelete(req)
	case "list_panel_dirs":
		return d.listPanelDirs(req)
	case "squad_log_list":
		return d.squadLogList(req)
	case "list_squad_containers":
		return d.listSquadContainers(ctx, req)
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
	case "container_stats":
		return d.containerStats(ctx, req)
	case "container_logs_follow":
		return d.containerLogsFollow(ctx, req, onStream)
	case "depot_update":
		return d.depotUpdate(ctx, req, onStream)
	case "docker_prune":
		return d.dockerPrune(ctx, req, onStream)
	case "backup_snapshots":
		return d.backupSnapshots(ctx, req)
	case "backup_run":
		return d.backupRun(ctx, req, onStream)
	case "backup_restore":
		return d.backupRestore(ctx, req, onStream)
	case "panel_disk_usage":
		return d.panelDiskUsage(req)
	case "squad_log_retention_sweep":
		return d.squadLogRetentionSweep(req)
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

const (
	// fileReadStreamDefaultChunkBytes is the read size used when the caller does
	// not pin chunk_size. 1 MiB keeps every emitted frame far below rpc.MaxFrame
	// (16 MiB) even after base64 expansion (~1.33 MiB), so an arbitrarily large
	// file (e.g. a 500 MB Squad log) is streamed frame-by-frame and is never
	// held whole in memory — the constraint that rules out plain file_read.
	fileReadStreamDefaultChunkBytes int64 = 1 << 20
	// fileReadStreamMaxChunkBytes bounds a caller-supplied chunk_size so the
	// base64-expanded frame still fits under rpc.MaxFrame with envelope room.
	fileReadStreamMaxChunkBytes int64 = 8 << 20
)

type fileReadStreamParams struct {
	Path      string `json:"path"`
	ChunkSize int64  `json:"chunk_size,omitempty"`
}

// fileReadStream streams a readable file back to the caller as an ordered
// sequence of stdout StreamFrames, each carrying a base64-encoded chunk. The
// file is read chunk_size bytes at a time and never buffered in full, so it
// satisfies the "500 MB download must not be held in memory" requirement.
// Modeled on containerLogsFollow (the existing streaming handler): the terminal
// Response reports how many bytes were streamed.
func (d *Dispatcher) fileReadStream(req *rpc.Request, onStream func(rpc.StreamFrame)) rpc.Response {
	var p fileReadStreamParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if err := validateReadablePath(p.Path); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeForbidden, err.Error())
	}
	chunkSize := p.ChunkSize
	if chunkSize <= 0 {
		chunkSize = fileReadStreamDefaultChunkBytes
	} else if chunkSize > fileReadStreamMaxChunkBytes {
		chunkSize = fileReadStreamMaxChunkBytes
	}
	f, err := os.Open(p.Path)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	} else if st.IsDir() {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, "path is a directory")
	}

	buf := make([]byte, chunkSize)
	var sent int64
	for {
		n, readErr := f.Read(buf)
		if n > 0 {
			encoded, _ := json.Marshal(base64.StdEncoding.EncodeToString(buf[:n]))
			onStream(rpc.StreamFrame{ID: req.ID, Stream: "stdout", Data: encoded})
			sent += int64(n)
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, readErr.Error())
		}
	}
	body, _ := json.Marshal(map[string]int64{"bytes_sent": sent})
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
	// Sidecar config dirs hold the rendered config.json with the server's
	// plaintext RCON password, so deleting a server must be able to remove them.
	if cleaned, err := validate.SidecarServerRoot(p); err == nil {
		return cleaned, nil
	}
	return "", fmt.Errorf("%w: directory_delete only allows {uuid} dirs under %s, %s or %s", validate.ErrForbidden, validate.PanelConfigsRoot, validate.PanelSavedRoot, validate.PanelSocketRoot)
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

type squadLogListParams struct {
	Path string `json:"path"`
}

type squadLogFile struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	Mtime  string `json:"mtime"`
	IsLive bool   `json:"is_live"`
}

// squadLogList returns the SquadGame*.log files in the caller-supplied Logs
// directory (validated read-only under the panel roots), each with its size,
// RFC3339 mtime, and an is_live flag set on the active SquadGame.log. The API
// builds the path as <saved>/<uuid>/SquadGame/Saved/Logs; a missing directory
// yields an empty list rather than an error, mirroring readImmediateDirs.
func (d *Dispatcher) squadLogList(req *rpc.Request) rpc.Response {
	var p squadLogListParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if err := validateReadablePath(p.Path); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeForbidden, err.Error())
	}
	entries, err := os.ReadDir(p.Path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			body, _ := json.Marshal(map[string][]squadLogFile{"files": {}})
			return rpc.NewSuccessResponse(req.ID, body)
		}
		return rpc.NewErrorResponse(req.ID, rpc.CodeRuntimeError, err.Error())
	}
	files := make([]squadLogFile, 0, len(entries))
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !isSquadGameLog(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, squadLogFile{
			Name:   entry.Name(),
			Size:   info.Size(),
			Mtime:  info.ModTime().UTC().Format(time.RFC3339),
			IsLive: entry.Name() == "SquadGame.log",
		})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	body, _ := json.Marshal(map[string][]squadLogFile{"files": files})
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

const (
	squadLogRetentionDays       = 10
	squadLogRetentionErrorLimit = 20
)

type squadLogRetentionSweepError struct {
	ServerID string `json:"server_id,omitempty"`
	File     string `json:"file,omitempty"`
	Error    string `json:"error"`
}

type squadLogRetentionSweepResult struct {
	RetentionDays  int                           `json:"retention_days"`
	Cutoff         string                        `json:"cutoff"`
	ServersScanned int                           `json:"servers_scanned"`
	LogDirsScanned int                           `json:"log_dirs_scanned"`
	FilesScanned   int                           `json:"files_scanned"`
	DeletedCount   int                           `json:"deleted_count"`
	DeletedBytes   int64                         `json:"deleted_bytes"`
	ArchivedCount  int                           `json:"archived_count"`
	ArchivedBytes  int64                         `json:"archived_bytes"`
	ErrorCount     int                           `json:"error_count"`
	Errors         []squadLogRetentionSweepError `json:"errors"`
}

// squadLogRetentionSweepParams carries the LOG-3 (#51) archive-enabled server
// set. The caller (worker-log-ingest) never controls filesystem paths — the
// swept root and the archive staging root are both owned by the bridge —
// so only server IDs are accepted. DisallowUnknownFields keeps rejecting a
// caller-supplied `path` (or any other key) as an invalid argument.
type squadLogRetentionSweepParams struct {
	ArchiveServerIDs []string `json:"archive_server_ids"`
}

func (d *Dispatcher) squadLogRetentionSweep(req *rpc.Request) rpc.Response {
	var p squadLogRetentionSweepParams
	if !emptyJSONParams(req.Params) {
		dec := json.NewDecoder(bytes.NewReader(req.Params))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&p); err != nil {
			return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
		}
	}

	archiveSet := make(map[string]struct{}, len(p.ArchiveServerIDs))
	for _, id := range p.ArchiveServerIDs {
		if err := validate.ServerUUID(id); err != nil {
			return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, "invalid archive_server_ids entry: "+id)
		}
		archiveSet[id] = struct{}{}
	}

	savedRoot := d.panelSavedRoot
	if savedRoot == "" {
		savedRoot = validate.PanelSavedRoot
	}
	backupDumpRoot := d.backupDumpRoot
	if backupDumpRoot == "" {
		backupDumpRoot = os.Getenv("PANEL_BACKUP_DUMP_ROOT")
	}
	now := time.Now().UTC()
	if d.nowFn != nil {
		now = d.nowFn().UTC()
	}

	result := runSquadLogRetentionSweep(savedRoot, now, squadLogRetentionDays, archiveSet, backupDumpRoot)
	body, _ := json.Marshal(result)
	return rpc.NewSuccessResponse(req.ID, body)
}

func emptyJSONParams(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || bytes.Equal(trimmed, []byte("{}"))
}

func runSquadLogRetentionSweep(savedRoot string, now time.Time, retentionDays int, archiveSet map[string]struct{}, backupDumpRoot string) squadLogRetentionSweepResult {
	retention := time.Duration(retentionDays) * 24 * time.Hour
	cutoff := now.Add(-retention)
	result := squadLogRetentionSweepResult{
		RetentionDays: retentionDays,
		Cutoff:        cutoff.Format(time.RFC3339),
		Errors:        []squadLogRetentionSweepError{},
	}

	serverEntries, err := os.ReadDir(savedRoot)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return result
		}
		result.addRetentionError("", "", fmt.Errorf("read saved root failed: %w", err))
		return result
	}

	for _, serverEntry := range serverEntries {
		if !serverEntry.IsDir() || validate.ServerUUID(serverEntry.Name()) != nil {
			continue
		}
		serverID := serverEntry.Name()
		_, archiveEnabled := archiveSet[serverID]
		result.ServersScanned++
		logsDir := filepath.Join(savedRoot, serverID, "SquadGame", "Saved", "Logs")
		logEntries, err := os.ReadDir(logsDir)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			result.addRetentionError(serverID, "", fmt.Errorf("read logs dir failed: %w", err))
			continue
		}
		result.LogDirsScanned++

		for _, logEntry := range logEntries {
			info, err := logEntry.Info()
			if err != nil {
				result.addRetentionError(serverID, logEntry.Name(), fmt.Errorf("stat log file failed: %w", err))
				continue
			}
			if !info.Mode().IsRegular() {
				continue
			}
			result.FilesScanned++
			if !isRotatedSquadGameLog(logEntry.Name()) {
				continue
			}
			if !info.ModTime().Add(retention).Before(now) {
				continue
			}
			// LOG-3 (#51): for a flagged server, copy the expiring file into the
			// restic backup staging tree BEFORE deleting it. A copy failure must
			// leave the file in place (Rule 7 safety) — never delete unarchived.
			if archiveEnabled {
				if err := archiveExpiringLog(backupDumpRoot, serverID, logsDir, logEntry.Name()); err != nil {
					result.addRetentionError(serverID, logEntry.Name(), fmt.Errorf("archive log file failed: %w", err))
					continue
				}
				result.ArchivedCount++
				result.ArchivedBytes += info.Size()
			}
			if err := os.Remove(filepath.Join(logsDir, logEntry.Name())); err != nil {
				result.addRetentionError(serverID, logEntry.Name(), fmt.Errorf("delete log file failed: %w", err))
				continue
			}
			result.DeletedCount++
			result.DeletedBytes += info.Size()
		}
	}

	return result
}

func isRotatedSquadGameLog(name string) bool {
	return name != "SquadGame.log" && strings.HasPrefix(name, "SquadGame") && strings.HasSuffix(name, ".log")
}

// archiveExpiringLog copies a single expiring rotated log into the restic
// backup staging tree at <backupDumpRoot>/log-archive/<serverID>/<name> before
// the retention sweep deletes it (LOG-3, #51). serverID is a validated UUID and
// name is a validated rotated-log filename, so neither can escape the staging
// root. The copy is staged to a sibling temp file and renamed into place so a
// snapshot never observes a half-written archive. Returns an error (leaving the
// source untouched) when the staging root is unconfigured or the copy fails —
// the caller then skips the delete.
func archiveExpiringLog(backupDumpRoot, serverID, logsDir, name string) error {
	if backupDumpRoot == "" {
		return fmt.Errorf("backup dump root not configured")
	}
	destDir := filepath.Join(backupDumpRoot, "log-archive", serverID)
	if err := os.MkdirAll(destDir, 0o750); err != nil {
		return fmt.Errorf("create staging dir failed: %w", err)
	}

	src, err := os.Open(filepath.Join(logsDir, name))
	if err != nil {
		return fmt.Errorf("open source failed: %w", err)
	}
	defer src.Close()

	tmp, err := os.CreateTemp(destDir, name+".*.tmp")
	if err != nil {
		return fmt.Errorf("create staging temp failed: %w", err)
	}
	tmpPath := tmp.Name()
	if _, err := io.Copy(tmp, src); err != nil {
		tmp.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("copy failed: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("sync failed: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("close staging temp failed: %w", err)
	}
	if err := os.Rename(tmpPath, filepath.Join(destDir, name)); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("rename staging temp failed: %w", err)
	}
	return nil
}

// isSquadGameLog matches the live SquadGame.log and every rotated SquadGame*.log
// sibling — the set of files browsable/downloadable through the panel.
func isSquadGameLog(name string) bool {
	return strings.HasPrefix(name, "SquadGame") && strings.HasSuffix(name, ".log")
}

func (r *squadLogRetentionSweepResult) addRetentionError(serverID string, file string, err error) {
	r.ErrorCount++
	if len(r.Errors) >= squadLogRetentionErrorLimit {
		return
	}
	r.Errors = append(r.Errors, squadLogRetentionSweepError{
		ServerID: serverID,
		File:     file,
		Error:    retentionErrorMessage(err),
	})
}

func retentionErrorMessage(err error) string {
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return pathErr.Err.Error()
	}
	return err.Error()
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

type containerRunRnsquadjsParams struct {
	ServerID string            `json:"server_id"`
	Env      map[string]string `json:"env"`
}

func (d *Dispatcher) containerRunRnsquadjs(ctx context.Context, req *rpc.Request) rpc.Response {
	var p containerRunRnsquadjsParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	id, err := d.Docker.RunRNSquadJS(ctx, runner.RNSquadJSRunSpec{
		ServerID: p.ServerID,
		Env:      p.Env,
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

// --- restic backup / restore (INFRA-8-P1) ---

// backupErrCode maps a backup runner error onto an RPC error code: policy
// rejections (unconfigured/relative compose dir, bad snapshot id) surface as
// forbidden, everything else as a runtime error.
func backupErrCode(err error) string {
	if isForbidden(err) {
		return rpc.CodeForbidden
	}
	return rpc.CodeRuntimeError
}

// backupSnapshots lists the restic snapshots in the panel backup repository.
func (d *Dispatcher) backupSnapshots(ctx context.Context, req *rpc.Request) rpc.Response {
	snaps, err := d.Docker.BackupSnapshots(ctx)
	if err != nil {
		return rpc.NewErrorResponse(req.ID, backupErrCode(err), err.Error())
	}
	body, _ := json.Marshal(map[string]any{"snapshots": snaps})
	return rpc.NewSuccessResponse(req.ID, body)
}

// backupRun triggers a one-off restic backup (dumps + snapshot + retention),
// streaming progress like dockerPrune.
func (d *Dispatcher) backupRun(
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
	exit, err := d.Docker.BackupRun(ctx, push("stdout"), push("stderr"))
	if err != nil {
		return rpc.NewErrorResponse(req.ID, backupErrCode(err), err.Error())
	}
	body, _ := json.Marshal(map[string]int{"exit_code": exit})
	return rpc.NewSuccessResponse(req.ID, body)
}

type backupRestoreParams struct {
	SnapshotID string `json:"snapshot_id"`
}

// backupRestore restores Postgres + Redis from a chosen restic snapshot. This
// is destructive; the snapshot id is validated in the runner before it reaches
// the shell. Streams progress.
func (d *Dispatcher) backupRestore(
	ctx context.Context,
	req *rpc.Request,
	onStream func(rpc.StreamFrame),
) rpc.Response {
	var p backupRestoreParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, err.Error())
	}
	if p.SnapshotID == "" {
		return rpc.NewErrorResponse(req.ID, rpc.CodeInvalidArgs, "snapshot_id is required")
	}
	push := func(stream string) func([]byte) {
		return func(chunk []byte) {
			raw, _ := json.Marshal(string(chunk))
			onStream(rpc.StreamFrame{ID: req.ID, Stream: stream, Data: raw})
		}
	}
	exit, err := d.Docker.BackupRestore(ctx, p.SnapshotID, push("stdout"), push("stderr"))
	if err != nil {
		return rpc.NewErrorResponse(req.ID, backupErrCode(err), err.Error())
	}
	body, _ := json.Marshal(map[string]int{"exit_code": exit})
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

// volumeOnDiskBytes returns the byte size of a docker volume, walking the
// real on-disk path. For bind-mounted volumes (`-o type=none -o o=bind`)
// `docker system df --format ... -v` reports 0B because the data is not
// owned by docker — we have to inspect the volume's `Options.device`
// (or fall back to `Mountpoint`) and `du -sb` it ourselves.
func volumeOnDiskBytes(name string) (int64, error) {
	out, err := exec.Command(
		"docker", "volume", "inspect",
		"--format", "{{index .Options \"device\"}}|{{.Mountpoint}}",
		name,
	).Output()
	if err != nil {
		return 0, fmt.Errorf("docker volume inspect %s: %w", name, err)
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "|", 2)
	device, mountpoint := parts[0], ""
	if len(parts) == 2 {
		mountpoint = parts[1]
	}
	path := device
	if path == "" {
		path = mountpoint
	}
	if path == "" {
		return 0, nil
	}
	return realDuBytes(path)
}

// dockerSystemDfReport mirrors the JSON produced by `docker system df
// --format '{{json .}}' -v` — ONE top-level object whose `Images` and
// `Volumes` arrays we filter against the panel-owned allowlists.
type dockerSystemDfReport struct {
	Images []struct {
		Repository string `json:"Repository"`
		Tag        string `json:"Tag"`
		Size       string `json:"Size"`
	} `json:"Images"`
	Volumes []struct {
		Name string `json:"Name"`
		Size string `json:"Size"`
	} `json:"Volumes"`
}

func realDockerDiskBreakdown() ([]dockerVol, []dockerImg, int64, error) {
	out, err := exec.Command("docker", "system", "df", "--format", "{{json .}}", "-v").Output()
	if err != nil {
		return nil, nil, 0, fmt.Errorf("docker system df: %w", err)
	}
	var report dockerSystemDfReport
	if err := json.Unmarshal(bytes.TrimSpace(out), &report); err != nil {
		return nil, nil, 0, fmt.Errorf("decode docker system df JSON: %w", err)
	}
	volumes := []dockerVol{}
	images := []dockerImg{}
	var depotBytes int64
	// `docker system df -v` silently skips bind-mounted volumes (no
	// docker-tracked size). Walk the panel-owned allowlist directly so
	// the depot's host-side bytes always show up.
	for name := range panelOwnedVolumes {
		size, err := volumeOnDiskBytes(name)
		if err != nil {
			// Volume does not exist on this host — that's OK, just
			// emit 0 bytes for it (e.g. caddy_data on a host that
			// hasn't started caddy yet).
			if strings.Contains(err.Error(), "No such volume") || strings.Contains(err.Error(), "exit status 1") {
				continue
			}
			return nil, nil, 0, err
		}
		volumes = append(volumes, dockerVol{Name: name, Bytes: size})
		if name == depotVolumeName {
			depotBytes = size
		}
	}
	// Sort for stable output / deterministic tests.
	sort.Slice(volumes, func(i, j int) bool { return volumes[i].Name < volumes[j].Name })
	for _, im := range report.Images {
		if _, owned := panelOwnedImages[im.Repository]; !owned {
			continue
		}
		size, err := parseHumanSize(im.Size)
		if err != nil {
			return nil, nil, 0, err
		}
		images = append(images, dockerImg{Repository: im.Repository, Tag: im.Tag, Bytes: size})
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
