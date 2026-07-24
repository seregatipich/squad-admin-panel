package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/runner"
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

func TestContainerRunRnsquadjs_BadUUIDReturnsForbidden(t *testing.T) {
	d := &Dispatcher{Docker: runner.NewDocker(&runner.Fake{})}
	params, _ := json.Marshal(map[string]any{
		"server_id": "not-a-uuid",
		"env":       map[string]string{},
	})
	req := &rpc.Request{ID: "req-rns-1", Method: "container_run_rnsquadjs", Params: params}
	resp := d.Handle(context.Background(), req, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
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

func TestSquadLogRetentionSweep_DeletesOnlyExpiredRotatedLogs(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	serverID := "019dbaa5-1234-7abc-8def-0123456789ab"
	savedRoot := t.TempDir()
	logsDir := filepath.Join(savedRoot, serverID, "SquadGame", "Saved", "Logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir logs dir: %v", err)
	}

	expiredRotated := filepath.Join(logsDir, "SquadGame-2026.06.26-12.00.00.log")
	liveLog := filepath.Join(logsDir, "SquadGame.log")
	freshRotated := filepath.Join(logsDir, "SquadGame-2026.06.30-12.00.00.log")
	nonMatching := filepath.Join(logsDir, "ChatGame-2026.06.26-12.00.00.log")
	expiredBytes := writeRetentionTestFile(t, expiredRotated, "expired rotated\n", now.Add(-11*24*time.Hour))
	writeRetentionTestFile(t, liveLog, "live old log\n", now.Add(-30*24*time.Hour))
	writeRetentionTestFile(t, freshRotated, "fresh rotated\n", now.Add(-9*24*time.Hour))
	writeRetentionTestFile(t, nonMatching, "other log\n", now.Add(-11*24*time.Hour))

	d := &Dispatcher{
		panelSavedRoot: savedRoot,
		nowFn:          func() time.Time { return now },
	}
	resp := d.Handle(context.Background(), &rpc.Request{
		ID:     "req-retention-1",
		Method: "squad_log_retention_sweep",
		Params: json.RawMessage(`{}`),
	}, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK, got error: %+v", resp.Error)
	}

	var got struct {
		RetentionDays  int    `json:"retention_days"`
		DeletedCount   int    `json:"deleted_count"`
		DeletedBytes   int64  `json:"deleted_bytes"`
		ErrorCount     int    `json:"error_count"`
		ServersScanned int    `json:"servers_scanned"`
		Cutoff         string `json:"cutoff"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if got.RetentionDays != 10 {
		t.Fatalf("retention_days = %d, want 10", got.RetentionDays)
	}
	if got.DeletedCount != 1 {
		t.Fatalf("deleted_count = %d, want 1", got.DeletedCount)
	}
	if got.DeletedBytes != expiredBytes {
		t.Fatalf("deleted_bytes = %d, want %d", got.DeletedBytes, expiredBytes)
	}
	if got.ErrorCount != 0 {
		t.Fatalf("error_count = %d, want 0", got.ErrorCount)
	}
	if got.ServersScanned != 1 {
		t.Fatalf("servers_scanned = %d, want 1", got.ServersScanned)
	}
	if got.Cutoff != now.Add(-10*24*time.Hour).Format(time.RFC3339) {
		t.Fatalf("cutoff = %q, want %q", got.Cutoff, now.Add(-10*24*time.Hour).Format(time.RFC3339))
	}

	assertPathMissing(t, expiredRotated)
	assertPathExists(t, liveLog)
	assertPathExists(t, freshRotated)
	assertPathExists(t, nonMatching)
}

func TestSquadLogRetentionSweep_RejectsCallerControlledPath(t *testing.T) {
	d := &Dispatcher{
		panelSavedRoot: t.TempDir(),
		nowFn:          func() time.Time { return time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC) },
	}
	resp := d.Handle(context.Background(), &rpc.Request{
		ID:     "req-retention-2",
		Method: "squad_log_retention_sweep",
		Params: json.RawMessage(`{"path":"/tmp/evil"}`),
	}, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeInvalidArgs {
		t.Fatalf("expected CodeInvalidArgs, got %+v", resp.Error)
	}
	if strings.Contains(resp.Error.Message, "unknown method") {
		t.Fatalf("method is not wired; got error %q", resp.Error.Message)
	}
}

func writeRetentionTestFile(t *testing.T, path string, content string, mtime time.Time) int64 {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", filepath.Base(path), err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatalf("chtimes %s: %v", filepath.Base(path), err)
	}
	return int64(len(content))
}

func assertPathExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected %s to exist, got %v", filepath.Base(path), err)
	}
}

func assertPathMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected %s to be deleted, stat err=%v", filepath.Base(path), err)
	}
}

// LOG-3 (#51): a flagged server's expiring rotated log must be copied into the
// restic backup staging tree BEFORE it is deleted from the Logs directory. The
// non-flagged sweep behaviour is unchanged (delete-only).
func TestSquadLogRetentionSweep_ArchivesFlaggedServerBeforeDelete(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	serverID := "019dbaa5-1234-7abc-8def-0123456789ab"
	savedRoot := t.TempDir()
	stagingRoot := t.TempDir()
	logsDir := filepath.Join(savedRoot, serverID, "SquadGame", "Saved", "Logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir logs dir: %v", err)
	}

	expiredName := "SquadGame-2026.06.26-12.00.00.log"
	expiredRotated := filepath.Join(logsDir, expiredName)
	freshRotated := filepath.Join(logsDir, "SquadGame-2026.06.30-12.00.00.log")
	expiredContent := "expired rotated payload to archive\n"
	expiredBytes := writeRetentionTestFile(t, expiredRotated, expiredContent, now.Add(-11*24*time.Hour))
	writeRetentionTestFile(t, freshRotated, "fresh rotated\n", now.Add(-9*24*time.Hour))

	d := &Dispatcher{
		panelSavedRoot: savedRoot,
		backupDumpRoot: stagingRoot,
		nowFn:          func() time.Time { return now },
	}
	resp := d.Handle(context.Background(), &rpc.Request{
		ID:     "req-retention-archive-1",
		Method: "squad_log_retention_sweep",
		Params: json.RawMessage(`{"archive_server_ids":["` + serverID + `"]}`),
	}, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK, got error: %+v", resp.Error)
	}

	var got struct {
		DeletedCount  int   `json:"deleted_count"`
		DeletedBytes  int64 `json:"deleted_bytes"`
		ArchivedCount int   `json:"archived_count"`
		ArchivedBytes int64 `json:"archived_bytes"`
		ErrorCount    int   `json:"error_count"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if got.ArchivedCount != 1 {
		t.Fatalf("archived_count = %d, want 1", got.ArchivedCount)
	}
	if got.ArchivedBytes != expiredBytes {
		t.Fatalf("archived_bytes = %d, want %d", got.ArchivedBytes, expiredBytes)
	}
	if got.DeletedCount != 1 {
		t.Fatalf("deleted_count = %d, want 1", got.DeletedCount)
	}
	if got.ErrorCount != 0 {
		t.Fatalf("error_count = %d, want 0", got.ErrorCount)
	}

	// The expiring file must be archived into the staging tree AND removed from Logs.
	archived := filepath.Join(stagingRoot, "log-archive", serverID, expiredName)
	assertPathExists(t, archived)
	body, err := os.ReadFile(archived)
	if err != nil {
		t.Fatalf("read archived file: %v", err)
	}
	if string(body) != expiredContent {
		t.Fatalf("archived content = %q, want %q", string(body), expiredContent)
	}
	assertPathMissing(t, expiredRotated)
	// The fresh (non-expired) file is neither archived nor deleted.
	assertPathExists(t, freshRotated)
	assertPathMissing(t, filepath.Join(stagingRoot, "log-archive", serverID, "SquadGame-2026.06.30-12.00.00.log"))
}

func TestSquadLogRetentionSweep_UnflaggedServerDeleteOnly(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	serverID := "019dbaa5-1234-7abc-8def-0123456789ab"
	savedRoot := t.TempDir()
	stagingRoot := t.TempDir()
	logsDir := filepath.Join(savedRoot, serverID, "SquadGame", "Saved", "Logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir logs dir: %v", err)
	}

	expiredName := "SquadGame-2026.06.26-12.00.00.log"
	expiredRotated := filepath.Join(logsDir, expiredName)
	writeRetentionTestFile(t, expiredRotated, "expired rotated\n", now.Add(-11*24*time.Hour))

	d := &Dispatcher{
		panelSavedRoot: savedRoot,
		backupDumpRoot: stagingRoot,
		nowFn:          func() time.Time { return now },
	}
	// Empty archive set (the backwards-compatible default): nothing is archived.
	resp := d.Handle(context.Background(), &rpc.Request{
		ID:     "req-retention-archive-2",
		Method: "squad_log_retention_sweep",
		Params: json.RawMessage(`{"archive_server_ids":[]}`),
	}, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK, got error: %+v", resp.Error)
	}

	var got struct {
		DeletedCount  int `json:"deleted_count"`
		ArchivedCount int `json:"archived_count"`
		ErrorCount    int `json:"error_count"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if got.DeletedCount != 1 {
		t.Fatalf("deleted_count = %d, want 1", got.DeletedCount)
	}
	if got.ArchivedCount != 0 {
		t.Fatalf("archived_count = %d, want 0", got.ArchivedCount)
	}
	if got.ErrorCount != 0 {
		t.Fatalf("error_count = %d, want 0", got.ErrorCount)
	}

	assertPathMissing(t, expiredRotated)
	// Nothing was written into the staging tree for an unflagged server.
	if _, err := os.Stat(filepath.Join(stagingRoot, "log-archive")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected no staging tree for unflagged server, stat err=%v", err)
	}
}

// LOG-3 (#51), safety (Rule 7): a copy failure must NOT delete the file. With no
// staging root configured, a flagged server's archive fails and the expiring
// file is left in place with an error recorded — never silently lost.
func TestSquadLogRetentionSweep_ArchiveFailureKeepsFile(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	serverID := "019dbaa5-1234-7abc-8def-0123456789ab"
	savedRoot := t.TempDir()
	logsDir := filepath.Join(savedRoot, serverID, "SquadGame", "Saved", "Logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir logs dir: %v", err)
	}

	expiredRotated := filepath.Join(logsDir, "SquadGame-2026.06.26-12.00.00.log")
	writeRetentionTestFile(t, expiredRotated, "expired rotated\n", now.Add(-11*24*time.Hour))

	d := &Dispatcher{
		panelSavedRoot: savedRoot,
		backupDumpRoot: "", // not configured → archive must fail
		nowFn:          func() time.Time { return now },
	}
	resp := d.Handle(context.Background(), &rpc.Request{
		ID:     "req-retention-archive-3",
		Method: "squad_log_retention_sweep",
		Params: json.RawMessage(`{"archive_server_ids":["` + serverID + `"]}`),
	}, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK envelope, got error: %+v", resp.Error)
	}

	var got struct {
		DeletedCount  int `json:"deleted_count"`
		ArchivedCount int `json:"archived_count"`
		ErrorCount    int `json:"error_count"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if got.DeletedCount != 0 {
		t.Fatalf("deleted_count = %d, want 0 (archive failed → no delete)", got.DeletedCount)
	}
	if got.ArchivedCount != 0 {
		t.Fatalf("archived_count = %d, want 0", got.ArchivedCount)
	}
	if got.ErrorCount != 1 {
		t.Fatalf("error_count = %d, want 1", got.ErrorCount)
	}
	// The file survives the failed archive attempt.
	assertPathExists(t, expiredRotated)
}

// LOG-3 (#51): a bogus archive_server_ids entry is rejected before any deletion.
func TestSquadLogRetentionSweep_RejectsMalformedArchiveServerID(t *testing.T) {
	d := &Dispatcher{
		panelSavedRoot: t.TempDir(),
		backupDumpRoot: t.TempDir(),
		nowFn:          func() time.Time { return time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC) },
	}
	resp := d.Handle(context.Background(), &rpc.Request{
		ID:     "req-retention-archive-4",
		Method: "squad_log_retention_sweep",
		Params: json.RawMessage(`{"archive_server_ids":["not-a-uuid"]}`),
	}, func(rpc.StreamFrame) {})
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

// --- squad_log_list ---

func TestSquadLogList_ListsSquadGameLogsWithMetadata(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", tmp)
	logsDir := filepath.Join(tmp, "SquadGame", "Saved", "Logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir logs dir: %v", err)
	}

	now := time.Date(2026, 7, 20, 8, 30, 0, 0, time.UTC)
	liveContent := "live log body\n"
	rotatedContent := "rotated log body which is longer\n"
	writeRetentionTestFile(t, filepath.Join(logsDir, "SquadGame.log"), liveContent, now)
	writeRetentionTestFile(t, filepath.Join(logsDir, "SquadGame-2026.07.19-12.00.00.log"),
		rotatedContent, now.Add(-24*time.Hour))
	// Non-matching files must be excluded from the listing.
	writeRetentionTestFile(t, filepath.Join(logsDir, "ChatGame.log"), "nope\n", now)
	writeRetentionTestFile(t, filepath.Join(logsDir, "notes.txt"), "nope\n", now)
	// A subdirectory must be skipped (only regular files are listed).
	if err := os.MkdirAll(filepath.Join(logsDir, "SquadGame.log.d"), 0o755); err != nil {
		t.Fatalf("mkdir nested: %v", err)
	}

	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]any{"path": logsDir})
	resp := d.Handle(context.Background(), &rpc.Request{
		ID:     "req-loglist-1",
		Method: "squad_log_list",
		Params: params,
	}, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK, got %+v", resp.Error)
	}

	var got struct {
		Files []struct {
			Name   string `json:"name"`
			Size   int64  `json:"size"`
			Mtime  string `json:"mtime"`
			IsLive bool   `json:"is_live"`
		} `json:"files"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Files) != 2 {
		t.Fatalf("files = %d (%+v), want 2 SquadGame*.log entries", len(got.Files), got.Files)
	}
	byName := map[string]struct {
		Size   int64
		Mtime  string
		IsLive bool
	}{}
	for _, f := range got.Files {
		byName[f.Name] = struct {
			Size   int64
			Mtime  string
			IsLive bool
		}{f.Size, f.Mtime, f.IsLive}
	}
	live, ok := byName["SquadGame.log"]
	if !ok {
		t.Fatalf("SquadGame.log missing from listing: %+v", got.Files)
	}
	if !live.IsLive {
		t.Fatalf("SquadGame.log is_live = false, want true")
	}
	if live.Size != int64(len(liveContent)) {
		t.Fatalf("SquadGame.log size = %d, want %d", live.Size, len(liveContent))
	}
	if live.Mtime != now.Format(time.RFC3339) {
		t.Fatalf("SquadGame.log mtime = %q, want %q", live.Mtime, now.Format(time.RFC3339))
	}
	rotated, ok := byName["SquadGame-2026.07.19-12.00.00.log"]
	if !ok {
		t.Fatalf("rotated log missing from listing: %+v", got.Files)
	}
	if rotated.IsLive {
		t.Fatalf("rotated log is_live = true, want false")
	}
	if rotated.Size != int64(len(rotatedContent)) {
		t.Fatalf("rotated size = %d, want %d", rotated.Size, len(rotatedContent))
	}
}

func TestSquadLogList_MissingDirReturnsEmpty(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", tmp)
	missing := filepath.Join(tmp, "SquadGame", "Saved", "Logs")

	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]any{"path": missing})
	resp := d.Handle(context.Background(), &rpc.Request{
		ID:     "req-loglist-empty",
		Method: "squad_log_list",
		Params: params,
	}, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK for missing dir, got %+v", resp.Error)
	}
	var got struct {
		Files []json.RawMessage `json:"files"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Files) != 0 {
		t.Fatalf("files = %d, want 0 for a missing Logs dir", len(got.Files))
	}
}

func TestSquadLogList_ForbiddenPath(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]any{"path": "/etc"})
	resp := d.Handle(context.Background(), &rpc.Request{
		ID:     "req-loglist-forbid",
		Method: "squad_log_list",
		Params: params,
	}, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected error for path outside allowlist, got success")
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}

// --- file_read_stream ---

// collectStreamFrames drives file_read_stream and returns the decoded, ordered
// chunk byte slices plus the final response.
func collectStreamFrames(t *testing.T, d *Dispatcher, req *rpc.Request) ([][]byte, rpc.Response) {
	t.Helper()
	var chunks [][]byte
	resp := d.Handle(context.Background(), req, func(f rpc.StreamFrame) {
		if f.ID != req.ID {
			t.Fatalf("stream frame id = %q, want %q", f.ID, req.ID)
		}
		if f.Stream != "stdout" {
			t.Fatalf("stream = %q, want stdout", f.Stream)
		}
		var b64 string
		if err := json.Unmarshal(f.Data, &b64); err != nil {
			t.Fatalf("frame data is not a JSON string: %v", err)
		}
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			t.Fatalf("frame data is not valid base64: %v", err)
		}
		buf := make([]byte, len(raw))
		copy(buf, raw)
		chunks = append(chunks, buf)
	})
	return chunks, resp
}

func TestFileReadStream_EmitsMultipleChunksExactly(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", tmp)
	logPath := filepath.Join(tmp, "SquadGame.log")
	content := []byte("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-the-quick-brown-fox\n")
	if err := os.WriteFile(logPath, content, 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	d := &Dispatcher{}
	const chunkSize = 8
	params, _ := json.Marshal(map[string]any{"path": logPath, "chunk_size": chunkSize})
	req := &rpc.Request{ID: "req-stream-1", Method: "file_read_stream", Params: params}
	chunks, resp := collectStreamFrames(t, d, req)
	if !resp.OK {
		t.Fatalf("expected OK, got %+v", resp.Error)
	}

	// A file of len(content) bytes read in chunkSize-byte reads must produce
	// ceil(len/chunkSize) frames — proof the content is streamed, not returned
	// whole in one frame.
	wantFrames := (len(content) + chunkSize - 1) / chunkSize
	if len(chunks) != wantFrames {
		t.Fatalf("emitted %d frames, want %d", len(chunks), wantFrames)
	}
	if len(chunks) < 2 {
		t.Fatalf("expected multiple frames, got %d (not chunked)", len(chunks))
	}
	var reassembled []byte
	for _, c := range chunks {
		if len(c) > chunkSize {
			t.Fatalf("frame carried %d bytes, exceeds chunk_size %d", len(c), chunkSize)
		}
		reassembled = append(reassembled, c...)
	}
	if !bytes.Equal(reassembled, content) {
		t.Fatalf("reassembled stream != file content\n got %q\nwant %q", reassembled, content)
	}

	var final struct {
		BytesSent int64 `json:"bytes_sent"`
	}
	if err := json.Unmarshal(resp.Result, &final); err != nil {
		t.Fatalf("decode final: %v", err)
	}
	if final.BytesSent != int64(len(content)) {
		t.Fatalf("bytes_sent = %d, want %d", final.BytesSent, len(content))
	}
}

func TestFileReadStream_DefaultChunkSpansMultipleFrames(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", tmp)
	logPath := filepath.Join(tmp, "SquadGame.log")
	// Larger than the default 1 MiB read chunk: proves the handler never holds
	// (or emits) the whole file at once — the criterion that rules out fileRead.
	size := fileReadStreamDefaultChunkBytes*2 + 4096
	content := make([]byte, size)
	for i := range content {
		content[i] = byte(i % 251)
	}
	if err := os.WriteFile(logPath, content, 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]any{"path": logPath})
	req := &rpc.Request{ID: "req-stream-2", Method: "file_read_stream", Params: params}
	chunks, resp := collectStreamFrames(t, d, req)
	if !resp.OK {
		t.Fatalf("expected OK, got %+v", resp.Error)
	}
	if len(chunks) < 3 {
		t.Fatalf("emitted %d frames for a >2 MiB file, want >= 3 (streamed)", len(chunks))
	}
	var total int
	for _, c := range chunks {
		if int64(len(c)) > fileReadStreamDefaultChunkBytes {
			t.Fatalf("frame carried %d bytes, exceeds default chunk %d", len(c), fileReadStreamDefaultChunkBytes)
		}
		total += len(c)
	}
	if total != len(content) {
		t.Fatalf("streamed %d bytes, want %d", total, len(content))
	}
	// Verify byte-exact reconstruction.
	var reassembled []byte
	for _, c := range chunks {
		reassembled = append(reassembled, c...)
	}
	if !bytes.Equal(reassembled, content) {
		t.Fatalf("reassembled stream != file content for large file")
	}
}

func TestFileReadStream_ForbiddenPath(t *testing.T) {
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]any{"path": "/etc/passwd"})
	req := &rpc.Request{ID: "req-stream-forbid", Method: "file_read_stream", Params: params}
	chunks, resp := collectStreamFrames(t, d, req)
	if resp.OK {
		t.Fatalf("expected error response, got success")
	}
	if len(chunks) != 0 {
		t.Fatalf("emitted %d frames before rejecting a forbidden path", len(chunks))
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}

func TestFileReadStream_TraversalRejected(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", tmp)
	// Path escapes the allowed depot root via traversal.
	evil := filepath.Join(tmp, "SquadGame", "Saved", "Logs", "..", "..", "..", "..", "etc", "shadow")
	d := &Dispatcher{}
	params, _ := json.Marshal(map[string]any{"path": evil})
	req := &rpc.Request{ID: "req-stream-traverse", Method: "file_read_stream", Params: params}
	chunks, resp := collectStreamFrames(t, d, req)
	if resp.OK {
		t.Fatalf("expected error for traversal path, got success")
	}
	if len(chunks) != 0 {
		t.Fatalf("emitted %d frames for a traversal path", len(chunks))
	}
	if resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("expected CodeForbidden, got %+v", resp.Error)
	}
}
