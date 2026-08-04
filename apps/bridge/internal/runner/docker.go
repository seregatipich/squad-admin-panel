package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

type DockerRunner struct {
	Bin string
	R   Runner
	// SocketRoot overrides the rnsquadjs per-server socket/config root
	// (production default validate.PanelSocketRoot). Tests point it at a
	// temp dir so ensureSidecarDir does not touch the real /run tree.
	SocketRoot string
	// ComposeDir is the panel deploy directory that holds docker-compose.yml,
	// .env and scripts/restore.sh. The backup RPCs run `docker compose` (and the
	// restore script) from here so they inherit RESTIC_PASSWORD/POSTGRES_PASSWORD
	// from .env instead of the bridge having to hold those secrets. Empty falls
	// back to the PANEL_COMPOSE_DIR env var; it is never accepted from RPC
	// params. Tests inject a t.TempDir.
	ComposeDir string
}

func NewDocker(r Runner) *DockerRunner {
	return &DockerRunner{Bin: "docker", R: r}
}

type ContainerRunSpec struct {
	ServerID     string
	Image        string
	GamePort     int
	QueryPort    int
	BeaconPort   int
	RCONPort     int
	MaxPlayers   int
	Tickrate     int
	Multihome    string
	ExtraArgs    []string
	ConfigsHost  string
	SavedHost    string
	DepotVolume  string
	UlimitNofile int
}

func (d *DockerRunner) Run(ctx context.Context, spec ContainerRunSpec) (string, error) {
	if err := validate.ServerUUID(spec.ServerID); err != nil {
		return "", err
	}
	if err := validate.ContainerImage(spec.Image); err != nil {
		return "", err
	}
	name := "squad-" + spec.ServerID
	if err := validate.ContainerName(name); err != nil {
		return "", err
	}
	if _, err := validate.PanelConfigsPath(spec.ConfigsHost); err != nil {
		return "", fmt.Errorf("configs mount: %w", err)
	}
	if _, err := validate.PanelSavedPath(spec.SavedHost); err != nil {
		return "", fmt.Errorf("saved mount: %w", err)
	}
	if spec.DepotVolume != validate.DepotVolumeName {
		return "", fmt.Errorf("%w: depot volume %q not in allowlist", validate.ErrForbidden, spec.DepotVolume)
	}
	if spec.UlimitNofile <= 0 {
		spec.UlimitNofile = 65536
	}
	if spec.Multihome == "" {
		spec.Multihome = "0.0.0.0"
	}
	if spec.MaxPlayers <= 0 {
		spec.MaxPlayers = 100
	}
	if spec.Tickrate <= 0 {
		spec.Tickrate = 50
	}
	// The entrypoint needs to chown the bind-mount targets as root before
	// dropping to uid 1001, so --user is set via the squad-server
	// entrypoint itself (runuser), NOT the docker --user flag.
	// Rootfs must be writable because runc creates mount points for the
	// bind mounts inside it before the container process starts.
	args := []string{
		"run", "-d",
		"--pull", "never",
		"--name", name,
		"--restart", "unless-stopped",
		"--network", "host",
		"-v", spec.DepotVolume + ":/squad:ro",
		"-v", spec.ConfigsHost + ":/squad/SquadGame/ServerConfig:rw",
		"-v", spec.SavedHost + ":/squad/SquadGame/Saved:rw",
		"--ulimit", fmt.Sprintf("nofile=%d:%d", spec.UlimitNofile, spec.UlimitNofile),
		"--label", "panel.server_id=" + spec.ServerID,
		"--label", "panel.kind=squad-server",
		spec.Image,
	}
	squadArgs := []string{
		"RANDOM=ALWAYS",
		fmt.Sprintf("Port=%d", spec.GamePort),
		fmt.Sprintf("QueryPort=%d", spec.QueryPort),
		fmt.Sprintf("BeaconPort=%d", spec.BeaconPort),
		fmt.Sprintf("RCONIP=%s", spec.Multihome),
		fmt.Sprintf("RCONPORT=%d", spec.RCONPort),
		fmt.Sprintf("FIXEDMAXPLAYERS=%d", spec.MaxPlayers),
		fmt.Sprintf("FIXEDMAXTICKRATE=%d", spec.Tickrate),
		fmt.Sprintf("MULTIHOME=%s", spec.Multihome),
		"-log",
	}
	squadArgs = append(squadArgs, spec.ExtraArgs...)
	args = append(args, squadArgs...)
	var out string
	// `docker run` failing at the OCI-runtime-create stage (the class this
	// retries) can leave a stale Created-but-never-started container holding
	// `name`; a bare retry would then fail with "name already in use" instead
	// of recovering. beforeRetry clears it the same way the operator's manual
	// force-stop did (best-effort: Rm already tolerates "no such container").
	beforeRetry := func() {
		_, _, _, _ = d.R.Run(ctx, d.Bin, []string{"rm", "-f", name}, nil)
	}
	err := retryTransientDockerFailures(ctx, beforeRetry, func() error {
		so, se, exit, runErr := d.R.Run(ctx, d.Bin, args, nil)
		out = strings.TrimSpace(string(so))
		if runErr != nil {
			return runErr
		}
		if exit != 0 {
			return fmt.Errorf("docker run exit %d: %s", exit, strings.TrimSpace(string(se)))
		}
		return nil
	})
	return out, err
}

// transientDockerRunErrorMarker matches the OCI-runtime/containerd mount
// error class documented in #266: a containerd/overlay2 race can transiently
// block container creation with an EROFS error on the auto-created bind
// mountpoint ("make mountpoint ... read-only file system"). It was observed
// on both `docker start` (existing container) and `docker run` (fresh
// container, different overlay2 layer each time), and cleared on its own
// within a few minutes. "read-only file system" is specific enough in this
// context (docker start/run stderr) not to collide with unrelated failures;
// retrying a bounded number of times turns a short-lived instance of it into
// an invisible blip instead of requiring an operator to notice and manually
// force-stop + retry.
const transientDockerRunErrorMarker = "read-only file system"

func isTransientDockerRunError(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), transientDockerRunErrorMarker)
}

// retryTransientDockerRunAttempts and retryTransientDockerRunBackoff bound
// the extra latency retries can add: the bridge-client RPC timeouts for
// container_start/container_run are 30s/60s (packages/bridge-client/src/client.ts),
// so the total added sleep (1s+2s=3s here) must stay comfortably under that,
// leaving headroom for the docker command's own execution time.
const retryTransientDockerRunAttempts = 3

var retryTransientDockerRunBackoff = []time.Duration{time.Second, 2 * time.Second}

// retryTransientDockerFailures runs op up to retryTransientDockerRunAttempts
// times, retrying only while op's error matches isTransientDockerRunError.
// beforeRetry (may be nil) runs before each retry, e.g. to clear a
// partially-created container left behind by the failed attempt. Context
// cancellation aborts the wait between attempts immediately.
func retryTransientDockerFailures(ctx context.Context, beforeRetry func(), op func() error) error {
	var err error
	for attempt := 0; attempt < retryTransientDockerRunAttempts; attempt++ {
		err = op()
		if !isTransientDockerRunError(err) {
			return err
		}
		if attempt >= len(retryTransientDockerRunBackoff) {
			break
		}
		if beforeRetry != nil {
			beforeRetry()
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(retryTransientDockerRunBackoff[attempt]):
		}
	}
	return err
}

// sidecarUID is the unprivileged uid the rnsquadjs sidecar runs as. The
// per-server socket dir must be owned by it so the sidecar can create
// rcon.sock inside the read-only container.
const sidecarUID = 1001

// sidecarSockModeRaw is the raw syscall mode for the only sidecar-writable
// level: group rwx + setgid, nothing for others. In a raw syscall mode the
// setgid bit is octal 0o2000 (S_ISGID); os.ModeSetgid (a high FileMode bit)
// must NOT be used here because Fchmod takes the raw bitmask, not a FileMode.
// os.Stat still surfaces 0o2000 as os.ModeSetgid, which the tests assert.
const sidecarSockModeRaw uint32 = 0o2770

// sidecarServerDirModeRaw is the raw syscall mode for the per-server parent
// dir holding the host-authored config.json: group r-x + setgid, no group
// write. It stays root-owned (never chowned) so the sidecar (uid 1001) cannot
// rewrite config.json through the rw bind; only the nested sock subdir is
// sidecar-writable.
const sidecarServerDirModeRaw uint32 = 0o2750

// allowedSidecarEnv is the exhaustive set of environment keys the API may
// pass through to the rnsquadjs sidecar. A compromised API container cannot
// inject loader/runtime overrides (LD_PRELOAD, NODE_OPTIONS, ...) because the
// bridge drops any key outside this allowlist before composing docker args.
var allowedSidecarEnv = map[string]struct{}{
	"SERVER_ID":           {},
	"LOG_FILE":            {},
	"PANEL_BRIDGE_MODE":   {},
	"PANEL_BRIDGE_SOCKET": {},
	"REDIS_URL":           {},
}

// RNSquadJSRunSpec describes a per-server rnsquadjs sidecar launch.
type RNSquadJSRunSpec struct {
	ServerID string            `json:"server_id"`
	Env      map[string]string `json:"env"`
}

// validateSidecarEnv enforces the env allowlist and rejects keys or values
// that could break out of a single `-e KEY=VALUE` docker token. '=' is barred
// in keys only; values legitimately carry ':' '/' '@' (e.g. a redis URL).
func validateSidecarEnv(env map[string]string) error {
	for key, value := range env {
		if key == "" {
			return fmt.Errorf("%w: empty sidecar env key", validate.ErrForbidden)
		}
		if _, ok := allowedSidecarEnv[key]; !ok {
			return fmt.Errorf("%w: sidecar env key %q not in allowlist", validate.ErrForbidden, key)
		}
		if strings.ContainsAny(key, "=\x00\n\r") {
			return fmt.Errorf("%w: sidecar env key %q contains a forbidden character", validate.ErrForbidden, key)
		}
		if strings.ContainsAny(value, "\x00\n\r") {
			return fmt.Errorf("%w: sidecar env value for %q contains a forbidden character", validate.ErrForbidden, key)
		}
	}
	return nil
}

// socketRoot returns the configured rnsquadjs socket/config root, defaulting
// to the production constant when SocketRoot is unset.
func (d *DockerRunner) socketRoot() string {
	if d.SocketRoot != "" {
		return d.SocketRoot
	}
	return validate.PanelSocketRoot
}

func (d *DockerRunner) composeRNSquadJSArgs(spec RNSquadJSRunSpec) ([]string, error) {
	if err := validate.ServerUUID(spec.ServerID); err != nil {
		return nil, err
	}
	name := "rnsquadjs-" + spec.ServerID
	if err := validate.ContainerName(name); err != nil {
		return nil, err
	}
	if err := validateSidecarEnv(spec.Env); err != nil {
		return nil, err
	}
	serverDir := d.socketRoot() + "/" + spec.ServerID
	logsBind := fmt.Sprintf("%s/%s/SquadGame/Saved/Logs:/squad/Logs:ro", validate.PanelSavedRoot, spec.ServerID)
	socketBind := fmt.Sprintf("%s/sock:/run/panelBridge:rw", serverDir)
	configBind := fmt.Sprintf("%s/config.json:/app/config.json:ro", serverDir)

	args := []string{
		"run", "-d",
		"--pull", "never",
		"--name", name,
		"--label", "panel.server_id=" + spec.ServerID,
		"--label", "panel.kind=rnsquadjs",
		"--network", "host",
		"--user", "1001:1001",
		"--read-only",
		"--restart", "unless-stopped",
		"-v", logsBind,
		"-v", socketBind,
		"-v", configBind,
	}
	keys := make([]string, 0, len(spec.Env))
	for k := range spec.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, spec.Env[k]))
	}
	args = append(args, validate.RNSquadJSImage)
	return args, nil
}

// ensureSidecarDir builds the two-level per-server tree the sidecar needs:
//
//	{root}/{id}/       0o2750, root-owned        — holds host-authored config.json
//	{root}/{id}/sock/  0o2770, chown uid 1001    — the only sidecar-writable level
//
// Splitting the levels keeps config.json out of any sidecar-writable mount: the
// container sees {id}/sock bound rw at /run/panelBridge and config.json bound
// :ro, so a compromised sidecar cannot rewrite the host config. In production
// the per-server parent additionally must resolve under PanelSocketRoot; the
// check is skipped when SocketRoot is test-overridden to a temp dir.
//
// Every mutation is anchored to a verified file descriptor, never a reusable
// path string. The root is opened O_NOFOLLOW|O_DIRECTORY, each level is created
// with Mkdirat and reopened O_NOFOLLOW|O_DIRECTORY relative to its parent fd,
// and chmod/chown run as Fchmod/Fchown on that fd. A racer with rename access
// to the parents (the API container bind-mounts the tree rw as uid 0)
// therefore cannot swap a verified directory for a symlink between the check
// and the privileged chmod/chown: a swapped-in symlink makes the O_NOFOLLOW
// reopen fail closed with ELOOP/ENOTDIR.
func (d *DockerRunner) ensureSidecarDir(serverID string) error {
	root := d.socketRoot()
	if d.SocketRoot == "" {
		if _, err := validate.PanelSocketPath(root + "/" + serverID); err != nil {
			return err
		}
	}
	rootFd, err := syscall.Open(root, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return forbidNonDir("sidecar root", root, err)
	}
	defer syscall.Close(rootFd)

	idFd, err := openVerifiedSidecarDir(rootFd, serverID, sidecarServerDirModeRaw, false)
	if err != nil {
		return err
	}
	defer syscall.Close(idFd)

	sockFd, err := openVerifiedSidecarDir(idFd, "sock", sidecarSockModeRaw, true)
	if err != nil {
		return err
	}
	return syscall.Close(sockFd)
}

// openVerifiedSidecarDir creates name under parentFd (tolerating an existing
// entry), reopens it O_NOFOLLOW|O_DIRECTORY relative to parentFd so a planted
// symlink fails closed, then forces the exact mode with Fchmod (Mkdirat honours
// the umask, which strips setgid and group bits). When chownToSidecar it
// Fchowns the inode to the sidecar uid; a non-root caller (dev/test) hits
// EPERM, tolerated because a non-root bridge cannot drive containers anyway.
// Returns the open fd; the caller owns closing it.
func openVerifiedSidecarDir(parentFd int, name string, mode uint32, chownToSidecar bool) (int, error) {
	if err := syscall.Mkdirat(parentFd, name, mode); err != nil && !errors.Is(err, syscall.EEXIST) {
		return -1, fmt.Errorf("create sidecar dir %q: %w", name, err)
	}
	fd, err := syscall.Openat(parentFd, name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return -1, forbidNonDir("sidecar path", name, err)
	}
	if err := syscall.Fchmod(fd, mode); err != nil {
		syscall.Close(fd)
		return -1, fmt.Errorf("chmod sidecar dir %q: %w", name, err)
	}
	if !chownToSidecar {
		return fd, nil
	}
	if err := syscall.Fchown(fd, sidecarUID, -1); err != nil {
		if errors.Is(err, syscall.EPERM) && os.Geteuid() != 0 {
			return fd, nil
		}
		syscall.Close(fd)
		return -1, fmt.Errorf("chown sidecar dir %q: %w", name, err)
	}
	return fd, nil
}

// forbidNonDir maps the "not a real directory" open failures (a planted
// symlink yields ELOOP under O_NOFOLLOW; a non-directory yields ENOTDIR under
// O_DIRECTORY) onto validate.ErrForbidden so callers can match the policy
// error, and wraps any other open failure verbatim.
func forbidNonDir(what, path string, err error) error {
	if errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENOTDIR) {
		return fmt.Errorf("%w: %s %q is not a real directory", validate.ErrForbidden, what, path)
	}
	return fmt.Errorf("open %s %q: %w", what, path, err)
}

func (d *DockerRunner) RunRNSquadJS(ctx context.Context, spec RNSquadJSRunSpec) (string, error) {
	args, err := d.composeRNSquadJSArgs(spec)
	if err != nil {
		return "", err
	}
	if err := d.ensureSidecarDir(spec.ServerID); err != nil {
		return "", err
	}
	// config.json is rendered by the API into the (root-owned) server dir. If it
	// is absent when docker runs the :ro bind, docker (root) silently creates a
	// DIRECTORY at the bind source, so fail loudly before launching the sidecar.
	//
	// This check stays a path-based Lstat (not fd-anchored) on purpose: unlike
	// the chmod/chown in ensureSidecarDir it drives no privileged mutation, so
	// the surviving check-to-bind race is non-escalating. The config content is
	// API-supplied by design, and the worst a delete race can do is let docker
	// create an empty dir at the bind source, which the sidecar entrypoint
	// rejects so the container exits — a nuisance, never a privilege escalation.
	configPath := d.socketRoot() + "/" + spec.ServerID + "/config.json"
	if info, err := os.Lstat(configPath); err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("config.json not rendered for %s", spec.ServerID)
	}
	so, se, exit, err := d.R.Run(ctx, d.Bin, args, nil)
	if err != nil {
		return strings.TrimSpace(string(so)), err
	}
	if exit != 0 {
		return strings.TrimSpace(string(so)), fmt.Errorf("docker run rnsquadjs exit %d: %s", exit, strings.TrimSpace(string(se)))
	}
	return strings.TrimSpace(string(so)), nil
}

func (d *DockerRunner) Start(ctx context.Context, name string) error {
	if err := validate.ContainerName(name); err != nil {
		return err
	}
	return retryTransientDockerFailures(ctx, nil, func() error {
		_, se, exit, err := d.R.Run(ctx, d.Bin, []string{"start", name}, nil)
		if err != nil {
			return err
		}
		if exit != 0 {
			return fmt.Errorf("docker start exit %d: %s", exit, strings.TrimSpace(string(se)))
		}
		return nil
	})
}

func (d *DockerRunner) Stop(ctx context.Context, name string, timeout time.Duration) error {
	if err := validate.ContainerName(name); err != nil {
		return err
	}
	secs := int(timeout.Seconds())
	if secs <= 0 {
		secs = 60
	}
	_, se, exit, err := d.R.Run(ctx, d.Bin, []string{"stop", "--time", fmt.Sprintf("%d", secs), name}, nil)
	if err != nil {
		return err
	}
	if exit != 0 {
		msg := strings.TrimSpace(string(se))
		if strings.Contains(strings.ToLower(msg), "no such container") {
			return nil
		}
		return fmt.Errorf("docker stop exit %d: %s", exit, msg)
	}
	return nil
}

func (d *DockerRunner) Rm(ctx context.Context, name string) error {
	if err := validate.ContainerName(name); err != nil {
		return err
	}
	_, se, exit, err := d.R.Run(ctx, d.Bin, []string{"rm", "-f", name}, nil)
	if err != nil {
		return err
	}
	if exit != 0 {
		msg := strings.TrimSpace(string(se))
		if strings.Contains(strings.ToLower(msg), "no such container") {
			return nil
		}
		return fmt.Errorf("docker rm exit %d: %s", exit, msg)
	}
	return nil
}

type InspectResult struct {
	Name       string            `json:"name"`
	State      string            `json:"state"`
	Running    bool              `json:"running"`
	Pid        int               `json:"pid"`
	StartedAt  string            `json:"started_at"`
	FinishedAt string            `json:"finished_at"`
	ExitCode   int               `json:"exit_code"`
	Image      string            `json:"image"`
	RestartCnt int               `json:"restart_count"`
	Labels     map[string]string `json:"labels"`
}

func (d *DockerRunner) Inspect(ctx context.Context, name string) (*InspectResult, error) {
	if err := validate.ContainerName(name); err != nil {
		return nil, err
	}
	so, se, exit, err := d.R.Run(ctx, d.Bin,
		[]string{"inspect", "--format={{json .}}", name}, nil)
	if err != nil {
		return nil, err
	}
	if exit != 0 {
		msg := strings.TrimSpace(string(se))
		lower := strings.ToLower(msg)
		if strings.Contains(lower, "no such object") || strings.Contains(lower, "no such container") {
			return &InspectResult{Name: name, State: "not_found", Running: false}, nil
		}
		return nil, fmt.Errorf("docker inspect exit %d: %s", exit, msg)
	}
	out := string(so)
	var raw struct {
		Name  string `json:"Name"`
		State struct {
			Status     string `json:"Status"`
			Running    bool   `json:"Running"`
			Pid        int    `json:"Pid"`
			ExitCode   int    `json:"ExitCode"`
			StartedAt  string `json:"StartedAt"`
			FinishedAt string `json:"FinishedAt"`
		} `json:"State"`
		Config struct {
			Image  string            `json:"Image"`
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
		RestartCount int `json:"RestartCount"`
	}
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		return nil, fmt.Errorf("parse inspect: %w", err)
	}
	return &InspectResult{
		Name:       strings.TrimPrefix(raw.Name, "/"),
		State:      raw.State.Status,
		Running:    raw.State.Running,
		Pid:        raw.State.Pid,
		StartedAt:  raw.State.StartedAt,
		FinishedAt: raw.State.FinishedAt,
		ExitCode:   raw.State.ExitCode,
		Image:      raw.Config.Image,
		RestartCnt: raw.RestartCount,
		Labels:     raw.Config.Labels,
	}, nil
}

type StatsResult struct {
	Name          string  `json:"name"`
	Found         bool    `json:"found"`
	CPUPercent    float64 `json:"cpu_percent"`
	MemUsedBytes  int64   `json:"mem_used_bytes"`
	MemLimitBytes int64   `json:"mem_limit_bytes"`
	MemPercent    float64 `json:"mem_percent"`
	Pids          int     `json:"pids"`
	SampledAt     string  `json:"sampled_at"`
}

func (d *DockerRunner) Stats(ctx context.Context, name string) (*StatsResult, error) {
	if err := validate.ContainerName(name); err != nil {
		return nil, err
	}
	so, se, exit, err := d.R.Run(ctx, d.Bin,
		[]string{"stats", "--no-stream", "--format", "{{json .}}", name}, nil)
	if err != nil {
		return nil, err
	}
	if exit != 0 {
		msg := strings.TrimSpace(string(se))
		if strings.Contains(msg, "No such container") || strings.Contains(msg, "no such container") {
			return &StatsResult{Name: name, Found: false}, nil
		}
		return nil, fmt.Errorf("docker stats exit %d: %s", exit, msg)
	}
	line := strings.TrimSpace(string(so))
	if line == "" {
		return &StatsResult{Name: name, Found: false}, nil
	}
	var raw struct {
		Name     string `json:"Name"`
		CPUPerc  string `json:"CPUPerc"`
		MemUsage string `json:"MemUsage"`
		MemPerc  string `json:"MemPerc"`
		PIDs     string `json:"PIDs"`
	}
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return nil, fmt.Errorf("parse stats: %w", err)
	}
	cpu, _ := parsePercent(raw.CPUPerc)
	memPct, _ := parsePercent(raw.MemPerc)
	used, limit := parseMemUsage(raw.MemUsage)
	var pids int
	_, _ = fmt.Sscanf(raw.PIDs, "%d", &pids)
	return &StatsResult{
		Name:          strings.TrimPrefix(raw.Name, "/"),
		Found:         true,
		CPUPercent:    cpu,
		MemUsedBytes:  used,
		MemLimitBytes: limit,
		MemPercent:    memPct,
		Pids:          pids,
		SampledAt:     time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func parsePercent(s string) (float64, error) {
	s = strings.TrimSpace(strings.TrimSuffix(s, "%"))
	if s == "" || s == "--" {
		return 0, nil
	}
	var f float64
	_, err := fmt.Sscanf(s, "%f", &f)
	return f, err
}

func parseMemUsage(s string) (int64, int64) {
	parts := strings.SplitN(s, "/", 2)
	if len(parts) != 2 {
		return 0, 0
	}
	return parseSize(strings.TrimSpace(parts[0])), parseSize(strings.TrimSpace(parts[1]))
}

func parseSize(s string) int64 {
	if s == "" {
		return 0
	}
	var n float64
	var unit string
	_, err := fmt.Sscanf(s, "%f%s", &n, &unit)
	if err != nil {
		return 0
	}
	unit = strings.ToUpper(strings.TrimSpace(unit))
	mul := int64(1)
	switch unit {
	case "B":
		mul = 1
	case "KB":
		mul = 1000
	case "KIB":
		mul = 1024
	case "MB":
		mul = 1000 * 1000
	case "MIB":
		mul = 1024 * 1024
	case "GB":
		mul = 1000 * 1000 * 1000
	case "GIB":
		mul = 1024 * 1024 * 1024
	case "TB":
		mul = 1000 * 1000 * 1000 * 1000
	case "TIB":
		mul = 1024 * 1024 * 1024 * 1024
	}
	return int64(n * float64(mul))
}

func (d *DockerRunner) LogsFollow(
	ctx context.Context,
	name string,
	tail int,
	onStdout, onStderr func([]byte),
) (int, error) {
	if err := validate.ContainerName(name); err != nil {
		return 0, err
	}
	args := []string{"logs", "--follow", "--timestamps"}
	if tail > 0 {
		args = append(args, "--tail", fmt.Sprintf("%d", tail))
	}
	args = append(args, name)
	return d.R.Stream(ctx, d.Bin, args, nil, onStdout, onStderr)
}

func (d *DockerRunner) VolumeEnsure(ctx context.Context, name string) error {
	if name != validate.DepotVolumeName {
		return fmt.Errorf("%w: volume %q not in allowlist", validate.ErrForbidden, name)
	}
	_, _, exit, err := d.R.Run(ctx, d.Bin, []string{"volume", "inspect", name}, nil)
	if err != nil {
		return err
	}
	if exit == 0 {
		return nil
	}
	_, se, exit2, err := d.R.Run(ctx, d.Bin, []string{"volume", "create", name}, nil)
	if err != nil {
		return err
	}
	if exit2 != 0 {
		return fmt.Errorf("docker volume create exit %d: %s", exit2, strings.TrimSpace(string(se)))
	}
	return nil
}

func (d *DockerRunner) DepotUpdate(
	ctx context.Context,
	onStdout, onStderr func([]byte),
) (int, error) {
	if err := d.VolumeEnsure(ctx, validate.DepotVolumeName); err != nil {
		return 0, err
	}
	jobName := fmt.Sprintf("squad-depot-init-%s", time.Now().UTC().Format("20060102150405"))
	if err := validate.ContainerName(jobName); err != nil {
		return 0, err
	}
	args := []string{
		"run", "--rm",
		"--name", jobName,
		"-v", validate.DepotVolumeName + ":/depot:rw",
		"--label", "panel.kind=depot-init",
		validate.DepotInitImage,
	}
	return d.R.Stream(ctx, d.Bin, args, nil, onStdout, onStderr)
}

// ListSquadContainers returns the names of every container whose name
// matches the per-server `squad-{uuid}` regex, regardless of running
// state (so the API can detect orphans whose UUID is no longer in DB).
func (d *DockerRunner) ListSquadContainers(ctx context.Context) ([]string, error) {
	so, se, exit, err := d.R.Run(ctx, d.Bin,
		[]string{"ps", "-a", "--no-trunc", "--filter", "name=^squad-", "--format", "{{.Names}}"}, nil)
	if err != nil {
		return nil, err
	}
	if exit != 0 {
		return nil, fmt.Errorf("docker ps failed: %s", strings.TrimSpace(string(se)))
	}
	out := []string{}
	for _, line := range strings.Split(strings.TrimSpace(string(so)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// docker ps `name=^squad-` is a substring match (no real anchor),
		// so revalidate against the strict squad-<uuid> regex.
		if validate.ContainerName(line) == nil {
			out = append(out, line)
		}
	}
	return out, nil
}

// SystemPrune removes stopped containers, unused images and the build
// cache. Volumes are deliberately NOT pruned — the panel's persistent
// state lives in the squad-depot volume and any per-server saved/configs
// volumes that should be cleaned via directory_delete + soft-delete.
//
// Streams stdout/stderr live like DepotUpdate; callers can use it to
// drive a progress UI. Returns the docker exit code.
func (d *DockerRunner) SystemPrune(
	ctx context.Context,
	onStdout, onStderr func([]byte),
) (int, error) {
	args := []string{
		"system", "prune",
		"-a", // unused images, not just dangling
		"-f", // no confirmation prompt
		"--filter", "label!=panel.preserve=true",
	}
	return d.R.Stream(ctx, d.Bin, args, nil, onStdout, onStderr)
}

// --- restic backup / restore (INFRA-8-P1) ---

// composeDir resolves the panel deploy directory the backup RPCs shell out in.
// It must be an absolute path, from the ComposeDir field or PANEL_COMPOSE_DIR;
// an unset or relative value is a policy error (ErrForbidden) so the RPC fails
// closed rather than running `docker compose` from an unexpected cwd.
func (d *DockerRunner) composeDir() (string, error) {
	dir := d.ComposeDir
	if dir == "" {
		dir = os.Getenv("PANEL_COMPOSE_DIR")
	}
	if dir == "" {
		return "", fmt.Errorf("%w: compose directory not configured (set PANEL_COMPOSE_DIR)", validate.ErrForbidden)
	}
	if !filepath.IsAbs(dir) {
		return "", fmt.Errorf("%w: compose directory %q must be absolute", validate.ErrForbidden, dir)
	}
	return dir, nil
}

// composeBackupArgs builds the `docker compose` prefix that targets the
// backup-profile service from the resolved deploy directory. The compose file
// and .env are pinned explicitly so the invocation is independent of the
// bridge's cwd.
func composeBackupArgs(dir string) []string {
	return []string{
		"compose",
		"--project-directory", dir,
		"-f", filepath.Join(dir, "docker-compose.yml"),
		"--profile", "backup",
	}
}

// BackupSnapshot is one restic snapshot as surfaced to the panel UI. It is the
// subset of `restic snapshots --json` fields the operator needs to pick a
// snapshot to restore.
type BackupSnapshot struct {
	ID       string   `json:"id"`
	ShortID  string   `json:"short_id"`
	Time     string   `json:"time"`
	Hostname string   `json:"hostname"`
	Paths    []string `json:"paths"`
	Tags     []string `json:"tags"`
}

// BackupSnapshots lists the restic snapshots in the panel's backup repository
// by running `restic snapshots --json` inside a one-off backup container (the
// resticker entrypoint is overridden so the args are not treated as a restic
// subcommand). An empty repository yields an empty slice, not an error.
func (d *DockerRunner) BackupSnapshots(ctx context.Context) ([]BackupSnapshot, error) {
	dir, err := d.composeDir()
	if err != nil {
		return nil, err
	}
	args := append(composeBackupArgs(dir),
		"run", "--rm", "--no-TTY",
		"--entrypoint", "/bin/sh", "backup",
		"-c", "restic snapshots --json",
	)
	so, se, exit, err := d.R.Run(ctx, d.Bin, args, nil)
	if err != nil {
		return nil, err
	}
	if exit != 0 {
		return nil, fmt.Errorf("restic snapshots exit %d: %s", exit, strings.TrimSpace(string(se)))
	}
	trimmed := strings.TrimSpace(string(so))
	if trimmed == "" {
		return []BackupSnapshot{}, nil
	}
	var snaps []BackupSnapshot
	if err := json.Unmarshal([]byte(trimmed), &snaps); err != nil {
		return nil, fmt.Errorf("parse restic snapshots json: %w", err)
	}
	return snaps, nil
}

// BackupRun triggers a one-off backup cycle by running the resticker `backup`
// command in a throwaway container: it evaluates the compose PRE_COMMANDS
// (pg_dump + redis-cli --rdb into the staging tree), takes a restic snapshot,
// then applies RESTIC_FORGET_ARGS retention. Streams progress; returns the
// exit code.
func (d *DockerRunner) BackupRun(
	ctx context.Context,
	onStdout, onStderr func([]byte),
) (int, error) {
	dir, err := d.composeDir()
	if err != nil {
		return 0, err
	}
	args := append(composeBackupArgs(dir), "run", "--rm", "backup", "backup")
	return d.R.Stream(ctx, d.Bin, args, nil, onStdout, onStderr)
}

// BackupRestore restores the panel's Postgres + Redis from the given restic
// snapshot by invoking the proven scripts/restore.sh from the deploy directory
// with --apply. This is DESTRUCTIVE: it overwrites the live database and Redis
// dataset. The snapshot id is validated to a restic id (or "latest") before it
// reaches the shell, so it cannot smuggle extra arguments. Streams progress;
// returns the script exit code.
func (d *DockerRunner) BackupRestore(
	ctx context.Context,
	snapshotID string,
	onStdout, onStderr func([]byte),
) (int, error) {
	dir, err := d.composeDir()
	if err != nil {
		return 0, err
	}
	if err := validate.ResticSnapshotID(snapshotID); err != nil {
		return 0, err
	}
	script := filepath.Join(dir, "scripts", "restore.sh")
	args := []string{script, "--apply", "--snapshot", snapshotID}
	return d.R.Stream(ctx, "bash", args, nil, onStdout, onStderr)
}
