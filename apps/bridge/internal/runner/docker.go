package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
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
	so, se, exit, err := d.R.Run(ctx, d.Bin, args, nil)
	if err != nil {
		return strings.TrimSpace(string(so)), err
	}
	if exit != 0 {
		return strings.TrimSpace(string(so)), fmt.Errorf("docker run exit %d: %s", exit, strings.TrimSpace(string(se)))
	}
	return strings.TrimSpace(string(so)), nil
}

// sidecarUID is the unprivileged uid the rnsquadjs sidecar runs as. The
// per-server socket dir must be owned by it so the sidecar can create
// rcon.sock inside the read-only container.
const sidecarUID = 1001

// sidecarSockMode keeps group rwx + setgid and denies others. The setgid bit
// is carried via os.ModeSetgid (NOT the raw 0o2000 octal bit, which Go's
// FileMode does not interpret) so os.Chmod emits S_ISGID. This is the only
// level chowned to the sidecar uid and the only level it can write.
const sidecarSockMode = os.FileMode(0o770) | os.ModeSetgid

// sidecarServerDirMode applies to the per-server parent dir, which holds the
// host-authored config.json. It stays root-owned (no chown) and denies group
// write so the sidecar (uid 1001) cannot rewrite config.json through the rw
// bind; only the nested sock subdir is sidecar-writable.
const sidecarServerDirMode = os.FileMode(0o750) | os.ModeSetgid

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
func (d *DockerRunner) ensureSidecarDir(serverID string) error {
	serverDir := d.socketRoot() + "/" + serverID
	if d.SocketRoot == "" {
		if _, err := validate.PanelSocketPath(serverDir); err != nil {
			return err
		}
	}
	if err := prepareSidecarDir(serverDir, sidecarServerDirMode, false); err != nil {
		return err
	}
	return prepareSidecarDir(serverDir+"/sock", sidecarSockMode, true)
}

// prepareSidecarDir creates a single tree level with the given mode. Root's
// chmod/chown follow symlinks, so it Lstats before and after MkdirAll and
// refuses to operate on anything that is not a real directory (a planted
// symlink, a file, ...), wrapping validate.ErrForbidden. MkdirAll honours the
// umask (stripping setgid and group bits), so the mode is forced with Chmod.
// chownToSidecar chowns the level to the sidecar uid; a non-root caller
// (dev/test) hits EPERM, tolerated because a non-root bridge cannot drive
// containers anyway.
func prepareSidecarDir(path string, mode os.FileMode, chownToSidecar bool) error {
	if err := assertRealDir(path); err != nil {
		return err
	}
	if err := os.MkdirAll(path, mode); err != nil {
		return fmt.Errorf("create sidecar dir: %w", err)
	}
	if err := assertRealDir(path); err != nil {
		return err
	}
	if err := os.Chmod(path, mode); err != nil {
		return fmt.Errorf("chmod sidecar dir: %w", err)
	}
	if !chownToSidecar {
		return nil
	}
	if err := os.Chown(path, sidecarUID, -1); err != nil {
		if errors.Is(err, syscall.EPERM) && os.Geteuid() != 0 {
			return nil
		}
		return fmt.Errorf("chown sidecar dir: %w", err)
	}
	return nil
}

// assertRealDir requires path to be absent or a real directory. A symlink (or
// any non-directory) is rejected with a forbidden error so a planted symlink
// cannot redirect root's subsequent chmod/chown to an attacker-chosen target.
func assertRealDir(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("lstat sidecar dir: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsDir() {
		return fmt.Errorf("%w: sidecar path %q is not a real directory", validate.ErrForbidden, path)
	}
	return nil
}

func (d *DockerRunner) RunRNSquadJS(ctx context.Context, spec RNSquadJSRunSpec) (string, error) {
	args, err := d.composeRNSquadJSArgs(spec)
	if err != nil {
		return "", err
	}
	if err := d.ensureSidecarDir(spec.ServerID); err != nil {
		return "", err
	}
	// config.json is rendered by the API into the server dir. If it is absent
	// when docker runs the :ro bind, docker (root) silently creates a DIRECTORY
	// there, so fail loudly before launching the sidecar.
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
	_, se, exit, err := d.R.Run(ctx, d.Bin, []string{"start", name}, nil)
	if err != nil {
		return err
	}
	if exit != 0 {
		return fmt.Errorf("docker start exit %d: %s", exit, strings.TrimSpace(string(se)))
	}
	return nil
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
