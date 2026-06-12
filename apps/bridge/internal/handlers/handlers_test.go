package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/validate"
)

func TestValidateDeletableDir_AcceptsConfigsAndSavedRoots(t *testing.T) {
	uuid := "019dbaa5-1234-7abc-8def-0123456789ab"
	cases := []string{
		"/var/lib/squad-panel/configs/" + uuid,
		"/var/lib/squad-panel/saved/" + uuid,
	}
	for _, p := range cases {
		cleaned, err := validateDeletableDir(p)
		if err != nil {
			t.Errorf("expected %q allowed, got %v", p, err)
		}
		if cleaned != p {
			t.Errorf("cleaned = %q, want %q", cleaned, p)
		}
	}
}

func TestValidateDeletableDir_RejectsEverythingElse(t *testing.T) {
	uuid := "019dbaa5-1234-7abc-8def-0123456789ab"
	cases := []string{
		"",
		"/etc/passwd",
		"/var/lib/squad-panel",
		"/var/lib/squad-panel/configs",
		"/var/lib/squad-panel/configs/" + uuid + "/ServerConfig",
		"/var/lib/squad-panel/configs/" + uuid + "/ServerConfig/Server.cfg",
		"/var/lib/squad-panel/saved/" + uuid + "/Logs/SquadGame.log",
		"/var/lib/squad-panel/configs/../etc",
		"/var/lib/squad-panel/configs/not-a-uuid",
		"/var/lib/docker/volumes/squad-depot/_data",
	}
	for _, p := range cases {
		_, err := validateDeletableDir(p)
		if err == nil {
			t.Errorf("expected rejection for %q", p)
			continue
		}
		if !errors.Is(err, validate.ErrForbidden) {
			t.Errorf("expected ErrForbidden for %q, got %v", p, err)
		}
	}
}

func TestDirectoryDelete_ForbiddenPathReturnsForbidden(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]string{"path": "/etc/passwd"})
	req := &rpc.Request{ID: "req-1", Method: "directory_delete", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}

func TestDirectoryDelete_FilePathUnderConfigsForbidden(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]string{
		"path": "/var/lib/squad-panel/configs/019dbaa5-1234-7abc-8def-0123456789ab/ServerConfig/Server.cfg",
	})
	req := &rpc.Request{ID: "req-2", Method: "directory_delete", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}

func TestDirectoryDelete_NonExistentValidPathIsIdempotent(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]string{
		"path": "/var/lib/squad-panel/configs/00000000-0000-7000-8000-000000000999",
	})
	req := &rpc.Request{ID: "req-3", Method: "directory_delete", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected success for non-existent valid path, got %+v", resp.Error)
	}
	var body map[string]bool
	if err := json.Unmarshal(resp.Result, &body); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if body["removed"] != false {
		t.Fatalf("expected removed=false for non-existent path, got %v", body)
	}
}

func TestDirectoryDelete_TraversalForbidden(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]string{
		"path": "/var/lib/squad-panel/configs/../etc",
	})
	req := &rpc.Request{ID: "req-4", Method: "directory_delete", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}

func TestDirectoryDelete_BadUUIDForbidden(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]string{
		"path": "/var/lib/squad-panel/configs/not-a-uuid",
	})
	req := &rpc.Request{ID: "req-5", Method: "directory_delete", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}

func TestDirectoryDelete_InvalidJSONReturnsInvalidArgs(t *testing.T) {
	d := &Dispatcher{}
	req := &rpc.Request{ID: "req-6", Method: "directory_delete", Params: []byte("not-json")}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeInvalidArgs {
		t.Fatalf("expected CodeInvalidArgs, got %+v", resp.Error)
	}
}

func TestValidateReadablePath_AcceptsConfigsAndSaved(t *testing.T) {
	cases := []string{
		"/var/lib/squad-panel/configs/019dbaa5-1234-7abc-8def-0123456789ab/ServerConfig/Admins.cfg",
		"/var/lib/squad-panel/saved/019dbaa5-1234-7abc-8def-0123456789ab/SquadGame/Saved/Logs/SquadGame.log",
	}
	for _, p := range cases {
		if err := validateReadablePath(p); err != nil {
			t.Errorf("expected %q allowed, got %v", p, err)
		}
	}
}

func TestValidateReadablePath_DepotDefault(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "")
	if err := validateReadablePath("/var/lib/docker/volumes/squad-depot/SquadGame/ServerConfig/Admins.cfg"); err != nil {
		t.Errorf("expected default depot root allowed, got %v", err)
	}
}

func TestValidateReadablePath_DepotHonorsEnv(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "/opt/panel-data/depot")
	if err := validateReadablePath("/opt/panel-data/depot/SquadGame/ServerConfig/Admins.cfg"); err != nil {
		t.Errorf("expected env-override depot root allowed, got %v", err)
	}
}

func TestValidateReadablePath_RejectsOutsideRoots(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "/opt/panel-data/depot")
	cases := []string{
		"/etc/shadow",
		"/var/lib/squad-panel/../etc/passwd",
		"/opt/panel-data/depot/../../etc/shadow",
		"/home/squad/.ssh/authorized_keys",
	}
	for _, p := range cases {
		err := validateReadablePath(p)
		if err == nil {
			t.Errorf("expected rejection for %q", p)
			continue
		}
		if !errors.Is(err, validate.ErrForbidden) {
			t.Errorf("expected ErrForbidden for %q, got %v", p, err)
		}
	}
}

func TestValidateWritablePath_AcceptsConfigsOnly(t *testing.T) {
	ok := "/var/lib/squad-panel/configs/019dbaa5-1234-7abc-8def-0123456789ab/ServerConfig/Admins.cfg"
	if err := validateWritablePath(ok); err != nil {
		t.Errorf("expected %q writable, got %v", ok, err)
	}
}

func TestValidateWritablePath_RejectsDepot(t *testing.T) {
	t.Setenv("PANEL_DEPOT_HOST_PATH", "/opt/panel-data/depot")
	bad := "/opt/panel-data/depot/SquadGame/ServerConfig/Admins.cfg"
	if err := validateWritablePath(bad); err == nil {
		t.Errorf("expected rejection for depot-write %q", bad)
	}
}

func TestValidateReadablePath_AcceptsSentinel(t *testing.T) {
	if err := validateReadablePath("/var/lib/squad-panel/.first-owner-claimed"); err != nil {
		t.Errorf("expected sentinel readable, got %v", err)
	}
}

func TestValidateReadablePath_RejectsSentinelNeighbours(t *testing.T) {
	cases := []string{
		"/var/lib/squad-panel/.first-owner-claim",
		"/var/lib/squad-panel/something-else",
		"/var/lib/squad-panel/.first-owner-claimed/extra",
	}
	for _, p := range cases {
		if err := validateReadablePath(p); err == nil {
			t.Errorf("expected rejection for %q", p)
		}
	}
}

func TestValidateWritablePath_AcceptsSentinel(t *testing.T) {
	if err := validateWritablePath("/var/lib/squad-panel/.first-owner-claimed"); err != nil {
		t.Errorf("expected sentinel writable, got %v", err)
	}
}

func TestValidateWritablePath_RejectsSentinelNeighbours(t *testing.T) {
	cases := []string{
		"/var/lib/squad-panel/.first-owner-claim",
		"/var/lib/squad-panel/something-else",
	}
	for _, p := range cases {
		if err := validateWritablePath(p); err == nil {
			t.Errorf("expected rejection for %q", p)
		}
	}
}

func TestHostAgentRestart_RespondsBeforeExec(t *testing.T) {
	execCalled := make(chan []string, 1)
	var execCount atomic.Int32

	d := &Dispatcher{
		restartDelay: 30 * time.Millisecond,
		RestartCommand: func() *exec.Cmd {
			execCount.Add(1)
			args := []string{"systemctl", "restart", "panel-host-bridge.service"}
			execCalled <- args
			// Use a no-op command so Start() succeeds without launching systemctl.
			return exec.Command("true")
		},
	}

	req := &rpc.Request{ID: "req-1", Method: "host_agent_restart"}
	respondedAt := time.Now()
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	respDuration := time.Since(respondedAt)

	if !resp.OK {
		t.Fatalf("expected OK response, got error: %+v", resp.Error)
	}
	var body map[string]string
	if err := json.Unmarshal(resp.Result, &body); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if body["status"] != "restarting" {
		t.Fatalf("expected status=restarting, got %q", body["status"])
	}
	if execCount.Load() != 0 {
		t.Fatalf("exec ran before response was returned (count=%d)", execCount.Load())
	}
	// Sanity: Handle should return well under the 30ms restart delay.
	if respDuration >= 30*time.Millisecond {
		t.Fatalf("handler took %v; should return immediately", respDuration)
	}

	select {
	case args := <-execCalled:
		want := []string{"systemctl", "restart", "panel-host-bridge.service"}
		if len(args) != len(want) {
			t.Fatalf("exec args = %v, want %v", args, want)
		}
		for i := range want {
			if args[i] != want[i] {
				t.Fatalf("exec args[%d] = %q, want %q", i, args[i], want[i])
			}
		}
	case <-time.After(2 * time.Second):
		t.Fatal("exec was never invoked after response delay")
	}
}

func newDiskUsageDispatcher(t *testing.T, root string) (*Dispatcher, *atomic.Int32, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	resetPanelDiskUsageCache()
	var duCalls atomic.Int32
	var statfsCalls atomic.Int32
	var dockerCalls atomic.Int32
	d := &Dispatcher{
		panelRoot: root,
		duFn: func(path string) (int64, error) {
			duCalls.Add(1)
			return realDuBytes(path)
		},
		statfsFn: func(path string, st *syscall.Statfs_t) error {
			statfsCalls.Add(1)
			st.Blocks = 1024
			st.Bavail = 512
			st.Bsize = 4096
			return nil
		},
		dockerDfFn: func() ([]dockerVol, []dockerImg, int64, error) {
			dockerCalls.Add(1)
			return []dockerVol{
					{Name: "squad-depot", Bytes: 1_000_000},
					{Name: "squad-panel_pg-data", Bytes: 50_000},
				},
				[]dockerImg{
					{Repository: "squad-server", Tag: "latest", Bytes: 2_500_000},
				},
				1_000_000,
				nil
		},
	}
	return d, &duCalls, &statfsCalls, &dockerCalls
}

func TestPanelDiskUsage_AllowlistedAndComputed(t *testing.T) {
	tmp := t.TempDir()
	uuid := "019dbaa5-1234-7abc-8def-0123456789ab"
	if err := os.MkdirAll(filepath.Join(tmp, "configs", uuid), 0o755); err != nil {
		t.Fatalf("mkdir configs: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(tmp, "saved", uuid), 0o755); err != nil {
		t.Fatalf("mkdir saved: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tmp, "configs", uuid, "x.cfg"), bytes.Repeat([]byte("a"), 100), 0o644); err != nil {
		t.Fatalf("write configs: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tmp, "saved", uuid, "log.txt"), bytes.Repeat([]byte("b"), 250), 0o644); err != nil {
		t.Fatalf("write saved: %v", err)
	}

	d, _, _, _ := newDiskUsageDispatcher(t, tmp)
	req := &rpc.Request{ID: "req-1", Method: "panel_disk_usage", Params: []byte("{}")}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK, got error: %+v", resp.Error)
	}
	var got panelDiskUsageResult
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ConfigsBytes < 100 {
		t.Fatalf("configs_bytes = %d, expected >= 100", got.ConfigsBytes)
	}
	if got.SavedTotalBytes < 250 {
		t.Fatalf("saved_total_bytes = %d, expected >= 250", got.SavedTotalBytes)
	}
	if got.AuditArchiveBytes != 0 {
		t.Fatalf("audit_archive_bytes = %d, expected 0 (missing dir)", got.AuditArchiveBytes)
	}
	if len(got.SavedPerServer) != 1 || got.SavedPerServer[0].UUID != uuid {
		t.Fatalf("saved_per_server = %+v, expected single uuid=%s", got.SavedPerServer, uuid)
	}
	if got.SavedPerServer[0].Bytes < 250 {
		t.Fatalf("saved_per_server[0].bytes = %d, expected >= 250", got.SavedPerServer[0].Bytes)
	}
	if got.DepotVolumeBytes != 1_000_000 {
		t.Fatalf("depot_volume_bytes = %d, expected 1_000_000", got.DepotVolumeBytes)
	}
	if len(got.DockerVolumes) != 2 || len(got.DockerImages) != 1 {
		t.Fatalf("docker_volumes=%d docker_images=%d, expected 2 and 1", len(got.DockerVolumes), len(got.DockerImages))
	}
	wantTotal := got.ConfigsBytes + got.SavedTotalBytes + got.AuditArchiveBytes
	for _, v := range got.DockerVolumes {
		wantTotal += v.Bytes
	}
	for _, im := range got.DockerImages {
		wantTotal += im.Bytes
	}
	if got.TotalPanelBytes != wantTotal {
		t.Fatalf("total_panel_bytes = %d, expected %d", got.TotalPanelBytes, wantTotal)
	}
	if got.HostTotalBytes != int64(1024)*int64(4096) {
		t.Fatalf("host_total_bytes = %d, expected %d", got.HostTotalBytes, int64(1024)*int64(4096))
	}
	if got.HostUsedBytes != int64(1024-512)*int64(4096) {
		t.Fatalf("host_used_bytes = %d, expected %d", got.HostUsedBytes, int64(1024-512)*int64(4096))
	}
	if _, err := time.Parse(time.RFC3339, got.ComputedAt); err != nil {
		t.Fatalf("computed_at = %q is not RFC3339: %v", got.ComputedAt, err)
	}
	if got.CacheAgeSeconds != 0 {
		t.Fatalf("cache_age_seconds = %d on fresh compute, expected 0", got.CacheAgeSeconds)
	}
}

func TestPanelDiskUsage_CachesWithinTTL(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, "configs"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	d, duCalls, statfsCalls, dockerCalls := newDiskUsageDispatcher(t, tmp)

	req := &rpc.Request{ID: "req-1", Method: "panel_disk_usage", Params: []byte("{}")}
	resp1 := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp1.OK {
		t.Fatalf("first call failed: %+v", resp1.Error)
	}
	firstDu := duCalls.Load()
	firstStatfs := statfsCalls.Load()
	firstDocker := dockerCalls.Load()
	if firstDu == 0 || firstStatfs == 0 || firstDocker == 0 {
		t.Fatalf("first call did not invoke probes (du=%d statfs=%d docker=%d)", firstDu, firstStatfs, firstDocker)
	}

	resp2 := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp2.OK {
		t.Fatalf("second call failed: %+v", resp2.Error)
	}
	if duCalls.Load() != firstDu {
		t.Fatalf("du re-invoked on cache hit (was %d, now %d)", firstDu, duCalls.Load())
	}
	if statfsCalls.Load() != firstStatfs {
		t.Fatalf("statfs re-invoked on cache hit (was %d, now %d)", firstStatfs, statfsCalls.Load())
	}
	if dockerCalls.Load() != firstDocker {
		t.Fatalf("docker df re-invoked on cache hit (was %d, now %d)", firstDocker, dockerCalls.Load())
	}

	var first, second panelDiskUsageResult
	if err := json.Unmarshal(resp1.Result, &first); err != nil {
		t.Fatalf("decode first: %v", err)
	}
	if err := json.Unmarshal(resp2.Result, &second); err != nil {
		t.Fatalf("decode second: %v", err)
	}
	if second.ComputedAt != first.ComputedAt {
		t.Fatalf("computed_at changed on cache hit: %q vs %q", first.ComputedAt, second.ComputedAt)
	}
	if second.CacheAgeSeconds < 0 {
		t.Fatalf("cache_age_seconds = %d, expected >= 0", second.CacheAgeSeconds)
	}
}

func TestPanelDiskUsage_MissingDirsReturnZero(t *testing.T) {
	tmp := t.TempDir()
	d, _, _, _ := newDiskUsageDispatcher(t, tmp)

	req := &rpc.Request{ID: "req-1", Method: "panel_disk_usage", Params: []byte("{}")}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK with empty tempdir, got: %+v", resp.Error)
	}
	var got panelDiskUsageResult
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ConfigsBytes != 0 {
		t.Fatalf("configs_bytes = %d, expected 0", got.ConfigsBytes)
	}
	if got.SavedTotalBytes != 0 {
		t.Fatalf("saved_total_bytes = %d, expected 0", got.SavedTotalBytes)
	}
	if got.AuditArchiveBytes != 0 {
		t.Fatalf("audit_archive_bytes = %d, expected 0", got.AuditArchiveBytes)
	}
	if len(got.SavedPerServer) != 0 {
		t.Fatalf("saved_per_server = %+v, expected empty", got.SavedPerServer)
	}
}

func TestPanelDiskUsage_ForceBypassesCache(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, "configs"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	d, duCalls, statfsCalls, dockerCalls := newDiskUsageDispatcher(t, tmp)

	cachedReq := &rpc.Request{ID: "req-1", Method: "panel_disk_usage", Params: []byte("{}")}
	resp1 := d.Handle(context.Background(), cachedReq, func(rpc.StreamFrame) {})
	if !resp1.OK {
		t.Fatalf("first call failed: %+v", resp1.Error)
	}
	firstDu := duCalls.Load()
	firstStatfs := statfsCalls.Load()
	firstDocker := dockerCalls.Load()
	if firstDu == 0 || firstStatfs == 0 || firstDocker == 0 {
		t.Fatalf("first call did not invoke probes (du=%d statfs=%d docker=%d)", firstDu, firstStatfs, firstDocker)
	}

	cacheHit := d.Handle(context.Background(), cachedReq, func(rpc.StreamFrame) {})
	if !cacheHit.OK {
		t.Fatalf("cache hit call failed: %+v", cacheHit.Error)
	}
	if duCalls.Load() != firstDu || statfsCalls.Load() != firstStatfs || dockerCalls.Load() != firstDocker {
		t.Fatalf("non-force call re-ran probes")
	}

	forceReq := &rpc.Request{ID: "req-2", Method: "panel_disk_usage", Params: []byte(`{"force":true}`)}
	respForce := d.Handle(context.Background(), forceReq, func(rpc.StreamFrame) {})
	if !respForce.OK {
		t.Fatalf("force call failed: %+v", respForce.Error)
	}
	if duCalls.Load() <= firstDu {
		t.Fatalf("force did not re-invoke du (was %d, now %d)", firstDu, duCalls.Load())
	}
	if statfsCalls.Load() <= firstStatfs {
		t.Fatalf("force did not re-invoke statfs (was %d, now %d)", firstStatfs, statfsCalls.Load())
	}
	if dockerCalls.Load() <= firstDocker {
		t.Fatalf("force did not re-invoke docker df (was %d, now %d)", firstDocker, dockerCalls.Load())
	}

	var first, force panelDiskUsageResult
	if err := json.Unmarshal(resp1.Result, &first); err != nil {
		t.Fatalf("decode first: %v", err)
	}
	if err := json.Unmarshal(respForce.Result, &force); err != nil {
		t.Fatalf("decode force: %v", err)
	}
	if force.CacheAgeSeconds != 0 {
		t.Fatalf("force cache_age_seconds = %d, expected 0", force.CacheAgeSeconds)
	}

	cachedAfterForce := d.Handle(context.Background(), cachedReq, func(rpc.StreamFrame) {})
	if !cachedAfterForce.OK {
		t.Fatalf("post-force cache hit failed: %+v", cachedAfterForce.Error)
	}
	postForceDu := duCalls.Load()
	if d.Handle(context.Background(), cachedReq, func(rpc.StreamFrame) {}); duCalls.Load() != postForceDu {
		t.Fatalf("non-force call after force re-invoked du; cache write skipped")
	}
}

func withDiagSink(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := &bytes.Buffer{}
	prev := DiagSink
	DiagSink = buf
	t.Cleanup(func() { DiagSink = prev })
	return buf
}

func TestDiagLog_ShapeMergesPayloadAndRequiredFields(t *testing.T) {
	buf := withDiagSink(t)

	DiagLog("bridge", "bridge.panic", "fatal", "test panic", map[string]any{"foo": "bar", "n": 42})

	var rec map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &rec); err != nil {
		t.Fatalf("decode: %v (raw=%q)", err, buf.String())
	}
	if rec["DIAG_EVENT"] != "1" {
		t.Fatalf("DIAG_EVENT = %v, want '1'", rec["DIAG_EVENT"])
	}
	if rec["component"] != "bridge" {
		t.Fatalf("component = %v, want 'bridge'", rec["component"])
	}
	if rec["kind"] != "bridge.panic" {
		t.Fatalf("kind = %v, want 'bridge.panic'", rec["kind"])
	}
	if rec["severity"] != "fatal" {
		t.Fatalf("severity = %v, want 'fatal'", rec["severity"])
	}
	if rec["message"] != "test panic" {
		t.Fatalf("message = %v, want 'test panic'", rec["message"])
	}
	if rec["foo"] != "bar" {
		t.Fatalf("payload not merged: %v", rec)
	}
	if rec["n"] != float64(42) {
		t.Fatalf("payload n not merged: %v", rec["n"])
	}
	if _, ok := rec["ts"].(string); !ok {
		t.Fatalf("ts missing or not a string: %v", rec["ts"])
	}
}

func TestDiagLog_PayloadCannotOverrideReservedKeys(t *testing.T) {
	buf := withDiagSink(t)

	DiagLog("bridge", "bridge.test", "info", "hi", map[string]any{
		"DIAG_EVENT": "0",
		"kind":       "evil",
		"component":  "evil",
		"severity":   "evil",
		"message":    "evil",
		"ts":         "evil",
	})

	var rec map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &rec); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rec["DIAG_EVENT"] != "1" || rec["kind"] != "bridge.test" || rec["component"] != "bridge" || rec["severity"] != "info" || rec["message"] != "hi" {
		t.Fatalf("reserved keys overridden: %+v", rec)
	}
	if rec["ts"] == "evil" {
		t.Fatalf("ts overridden by payload")
	}
}

func TestDispatcher_PanicEmitsDiagAndReturnsInternalError(t *testing.T) {
	buf := withDiagSink(t)

	resetPanelDiskUsageCache()
	t.Cleanup(resetPanelDiskUsageCache)

	d := &Dispatcher{
		duFn:     func(string) (int64, error) { panic("synthetic-du-panic") },
		statfsFn: func(string, *syscall.Statfs_t) error { return nil },
		dockerDfFn: func() ([]dockerVol, []dockerImg, int64, error) {
			return []dockerVol{}, []dockerImg{}, 0, nil
		},
		panelRoot: t.TempDir(),
	}

	resp := d.Handle(context.Background(), &rpc.Request{
		ID:     "req-panic-1",
		Method: "panel_disk_usage",
		Params: json.RawMessage(`{}`),
	}, func(rpc.StreamFrame) {})

	if resp.OK {
		t.Fatalf("expected error response after panic, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeInternal {
		t.Fatalf("expected internal error, got %+v", resp.Error)
	}

	out := buf.String()
	if !strings.Contains(out, `"DIAG_EVENT":"1"`) {
		t.Fatalf("expected DIAG_EVENT line in stderr, got %q", out)
	}
	if !strings.Contains(out, `"kind":"bridge.panic"`) {
		t.Fatalf("expected kind=bridge.panic, got %q", out)
	}
	if !strings.Contains(out, `"recovered":"synthetic-du-panic"`) {
		t.Fatalf("expected recovered field with the panic value, got %q", out)
	}
	if !strings.Contains(out, `"request_id":"req-panic-1"`) {
		t.Fatalf("expected request_id field, got %q", out)
	}
}

func TestFileReadTail_SnapsToNextNewline(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", tmp)

	logPath := filepath.Join(tmp, "SquadGame.log")
	content := []byte("line1\nline2\nline3\nline4\n")
	if err := os.WriteFile(logPath, content, 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]any{"path": logPath, "max_bytes": 10})
	req := &rpc.Request{ID: "req-tail-1", Method: "file_read_tail", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK, got %+v", resp.Error)
	}
	var got struct {
		Content   string `json:"content"`
		Offset    int64  `json:"offset"`
		Size      int64  `json:"size"`
		Truncated bool   `json:"truncated"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Size != int64(len(content)) {
		t.Fatalf("size = %d, want %d", got.Size, len(content))
	}
	if !got.Truncated {
		t.Fatalf("truncated = false, want true (file 24 bytes, max_bytes 10)")
	}
	if got.Content == "" {
		t.Fatalf("content empty")
	}
	if !strings.HasPrefix(got.Content, "line") {
		t.Fatalf("content = %q does not start at a line boundary", got.Content)
	}
	if !strings.HasSuffix(got.Content, "\n") {
		t.Fatalf("content = %q does not end with newline", got.Content)
	}
	if got.Offset <= 0 || got.Offset >= got.Size {
		t.Fatalf("offset = %d, want between 1 and %d", got.Offset, got.Size-1)
	}
	if content[got.Offset-1] != '\n' {
		t.Fatalf("offset %d does not point to a byte right after a newline", got.Offset)
	}
}

func TestFileReadTail_SmallFileReturnsWholeContent(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", tmp)

	logPath := filepath.Join(tmp, "small.log")
	content := []byte("line1\nline2\n")
	if err := os.WriteFile(logPath, content, 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]any{"path": logPath, "max_bytes": 1024})
	req := &rpc.Request{ID: "req-tail-small", Method: "file_read_tail", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK, got %+v", resp.Error)
	}
	var got struct {
		Content   string `json:"content"`
		Offset    int64  `json:"offset"`
		Size      int64  `json:"size"`
		Truncated bool   `json:"truncated"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Truncated {
		t.Fatalf("truncated = true on under-cap file")
	}
	if got.Offset != 0 {
		t.Fatalf("offset = %d, want 0", got.Offset)
	}
	if got.Content != string(content) {
		t.Fatalf("content = %q, want %q", got.Content, string(content))
	}
}

func TestFileReadTail_ForbiddenPath(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]any{"path": "/etc/passwd", "max_bytes": 1024})
	req := &rpc.Request{ID: "req-tail-forbid", Method: "file_read_tail", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}

func TestFileReadTail_DefaultCap(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", tmp)

	logPath := filepath.Join(tmp, "huge.log")
	line := []byte("0123456789abcdef0123456789abcdef\n")
	totalBytes := int64(0)
	f, err := os.Create(logPath)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	for totalBytes < 200*1024 {
		n, err := f.Write(line)
		if err != nil {
			f.Close()
			t.Fatalf("write: %v", err)
		}
		totalBytes += int64(n)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]any{"path": logPath, "max_bytes": 0})
	req := &rpc.Request{ID: "req-tail-cap", Method: "file_read_tail", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK, got %+v", resp.Error)
	}
	var got struct {
		Content   string `json:"content"`
		Offset    int64  `json:"offset"`
		Size      int64  `json:"size"`
		Truncated bool   `json:"truncated"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Size != totalBytes {
		t.Fatalf("size = %d, want %d", got.Size, totalBytes)
	}
	if !got.Truncated {
		t.Fatalf("truncated = false on 200 KB file with default cap")
	}
	if int64(len(got.Content)) > fileReadTailDefaultMaxBytes {
		t.Fatalf("content length %d exceeds default cap %d", len(got.Content), fileReadTailDefaultMaxBytes)
	}
	if got.Size-got.Offset > fileReadTailDefaultMaxBytes {
		t.Fatalf("read window %d exceeds default cap %d", got.Size-got.Offset, fileReadTailDefaultMaxBytes)
	}
}

func TestFileReadTail_ClampsToCeiling(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", tmp)

	logPath := filepath.Join(tmp, "huge.log")
	line := []byte("0123456789abcdef0123456789abcdef\n")
	fileSize := int64(0)
	targetSize := int64(2 << 20)
	f, err := os.Create(logPath)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	for fileSize < targetSize {
		n, err := f.Write(line)
		if err != nil {
			f.Close()
			t.Fatalf("write: %v", err)
		}
		fileSize += int64(n)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]any{"path": logPath, "max_bytes": int64(2 << 20)})
	req := &rpc.Request{ID: "req-tail-clamp", Method: "file_read_tail", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK, got %+v", resp.Error)
	}
	var got struct {
		Content   string `json:"content"`
		Offset    int64  `json:"offset"`
		Size      int64  `json:"size"`
		Truncated bool   `json:"truncated"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Size != fileSize {
		t.Fatalf("size = %d, want %d", got.Size, fileSize)
	}
	if !got.Truncated {
		t.Fatalf("truncated = false, want true")
	}
	contentLen := int64(len(got.Content))
	ceiling := fileReadTailMaxAllowedBytes
	if contentLen > ceiling {
		t.Fatalf("content length %d exceeds 1 MiB ceiling %d", contentLen, ceiling)
	}
	if contentLen < ceiling-int64(len(line)) {
		t.Fatalf("content length %d well below 1 MiB ceiling %d (expected ~1 MiB minus newline-snap slack)", contentLen, ceiling)
	}
	if contentLen <= fileReadTailDefaultMaxBytes {
		t.Fatalf("content length %d collapsed to default cap %d instead of clamping to ceiling", contentLen, fileReadTailDefaultMaxBytes)
	}
}

func TestFileReadTail_HonorsExplicitMaxBytes(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", tmp)

	logPath := filepath.Join(tmp, "huge.log")
	line := []byte("0123456789abcdef0123456789abcdef\n")
	fileSize := int64(0)
	f, err := os.Create(logPath)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	for fileSize < 200*1024 {
		n, err := f.Write(line)
		if err != nil {
			f.Close()
			t.Fatalf("write: %v", err)
		}
		fileSize += int64(n)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	requested := int64(32 * 1024)
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]any{"path": logPath, "max_bytes": requested})
	req := &rpc.Request{ID: "req-tail-exact", Method: "file_read_tail", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK, got %+v", resp.Error)
	}
	var got struct {
		Content   string `json:"content"`
		Offset    int64  `json:"offset"`
		Size      int64  `json:"size"`
		Truncated bool   `json:"truncated"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.Truncated {
		t.Fatalf("truncated = false on file larger than requested window")
	}
	window := got.Size - got.Offset
	if window > requested {
		t.Fatalf("read window %d exceeds requested %d", window, requested)
	}
	if window < requested-int64(len(line)) {
		t.Fatalf("read window %d well below requested %d (newline-snap should drop at most one line)", window, requested)
	}
}

func TestDispatcher_HostAgentRestartEmitsDiag(t *testing.T) {
	buf := withDiagSink(t)

	d := &Dispatcher{
		RestartCommand: func() *exec.Cmd { return exec.Command("true") },
		restartDelay:   time.Millisecond,
	}

	resp := d.Handle(context.Background(), &rpc.Request{
		ID:     "req-restart-1",
		Method: "host_agent_restart",
	}, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected success, got %+v", resp.Error)
	}

	out := buf.String()
	if !strings.Contains(out, `"kind":"bridge.host_agent_restart"`) {
		t.Fatalf("expected kind=bridge.host_agent_restart, got %q", out)
	}
	if !strings.Contains(out, `"request_id":"req-restart-1"`) {
		t.Fatalf("expected request_id field, got %q", out)
	}
}

// TestVolumeOnDiskBytes_BindMountedVolumeReturnsRealSize guards the regression
// where `docker system df --format ... -v` reports 0B for bind-mounted named
// volumes (Squad's depot is bind-mounted to ${DATA_DIR}/depot). The reported
// 0B made the panel-disk-usage endpoint claim 0 B for squad-depot even
// though the on-disk path held tens of MB. Fixed by walking the on-disk path
// returned by `docker volume inspect` instead.
func TestVolumeOnDiskBytes_BindMountedVolumeReturnsRealSize(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not available in test environment")
	}
	tmp := t.TempDir()
	// Populate the bind-mount source so du reports a non-zero byte count.
	payload := bytes.Repeat([]byte("x"), 4096)
	if err := os.WriteFile(filepath.Join(tmp, "marker.bin"), payload, 0o644); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	volName := fmt.Sprintf("squad-panel-test-%d", time.Now().UnixNano())
	cmd := exec.Command(
		"docker", "volume", "create",
		"--driver", "local",
		"--opt", "type=none", "--opt", "o=bind",
		"--opt", "device="+tmp,
		volName,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("docker volume create failed (likely no docker daemon access in CI): %v: %s", err, out)
	}
	t.Cleanup(func() {
		_ = exec.Command("docker", "volume", "rm", volName).Run()
	})

	got, err := volumeOnDiskBytes(volName)
	if err != nil {
		t.Fatalf("volumeOnDiskBytes: %v", err)
	}
	if got < int64(len(payload)) {
		t.Fatalf("volumeOnDiskBytes(%s) = %d, expected >= %d", volName, got, len(payload))
	}
}
