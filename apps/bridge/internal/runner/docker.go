package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

type DockerRunner struct {
	Bin string
	R   Runner
}

func NewDocker(r Runner) *DockerRunner {
	return &DockerRunner{Bin: "docker", R: r}
}

type ContainerRunSpec struct {
	ServerID    string
	Image       string
	GamePort    int
	QueryPort   int
	BeaconPort  int
	RCONPort    int
	MaxPlayers  int
	Tickrate    int
	Multihome   string
	ExtraArgs   []string
	ConfigsHost string
	SavedHost   string
	DepotVolume string
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
		if strings.Contains(msg, "No such container") {
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
		if strings.Contains(msg, "No such container") {
			return nil
		}
		return fmt.Errorf("docker rm exit %d: %s", exit, msg)
	}
	return nil
}

type InspectResult struct {
	Name       string         `json:"name"`
	State      string         `json:"state"`
	Running    bool           `json:"running"`
	Pid        int            `json:"pid"`
	StartedAt  string         `json:"started_at"`
	FinishedAt string         `json:"finished_at"`
	ExitCode   int            `json:"exit_code"`
	Image      string         `json:"image"`
	RestartCnt int            `json:"restart_count"`
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
		if strings.Contains(msg, "No such object") {
			return &InspectResult{Name: name, State: "not_found", Running: false}, nil
		}
		return nil, fmt.Errorf("docker inspect exit %d: %s", exit, msg)
	}
	out := string(so)
	var raw struct {
		Name   string `json:"Name"`
		State  struct {
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

