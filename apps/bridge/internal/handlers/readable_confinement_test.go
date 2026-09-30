package handlers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/validate"
)

// Regression tests for #13 (finding #382 follow-up and finding #398): the
// readable roots contain directories the game container can write to, so
// every read must be confined to its trust root — a symlink planted inside
// may not redirect the root-owned bridge to a host file, and a FIFO or
// device may not stall or flood it.

const confinementSecret = "host-secret-must-not-leak\n"

// depotRootWithEscapingLink points the depot readable root at a temp dir and
// plants name inside it as a symlink to a file outside every readable root.
func depotRootWithEscapingLink(t *testing.T, name string) (root, linkPath, outsideFile string) {
	t.Helper()
	root = t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", root)
	outsideFile = filepath.Join(t.TempDir(), "shadow")
	if err := os.WriteFile(outsideFile, []byte(confinementSecret), 0o600); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	linkPath = filepath.Join(root, name)
	if err := os.Symlink(outsideFile, linkPath); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	return root, linkPath, outsideFile
}

func assertNoSecret(t *testing.T, resp rpc.Response, frames int) {
	t.Helper()
	if resp.OK {
		t.Fatalf("expected an error for a path escaping its root via symlink, got success: %s", resp.Result)
	}
	if frames != 0 {
		t.Fatalf("emitted %d frames for a path escaping its root via symlink", frames)
	}
	if strings.Contains(string(resp.Result), strings.TrimSpace(confinementSecret)) {
		t.Fatalf("response leaked the outside file: %s", resp.Result)
	}
}

func TestFileReadStream_RejectsSymlinkEscapingRoot(t *testing.T) {
	_, link, _ := depotRootWithEscapingLink(t, "SquadGame-evil.log")
	params, _ := json.Marshal(map[string]any{"path": link})
	chunks, resp := collectStreamFrames(t, &Dispatcher{}, &rpc.Request{ID: "req-symlink-stream", Method: "file_read_stream", Params: params})
	assertNoSecret(t, resp, len(chunks))
}

func TestFileRead_RejectsSymlinkEscapingRoot(t *testing.T) {
	_, link, _ := depotRootWithEscapingLink(t, "Server.cfg")
	params, _ := json.Marshal(map[string]any{"path": link})
	resp := (&Dispatcher{}).Handle(context.Background(), &rpc.Request{ID: "req-symlink-read", Method: "file_read", Params: params}, func(rpc.StreamFrame) {})
	assertNoSecret(t, resp, 0)
}

func TestFileRead_ReadsRegularFileInsideRoot(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", root)
	cfg := filepath.Join(root, "ServerConfig", "Server.cfg")
	if err := os.MkdirAll(filepath.Dir(cfg), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(cfg, []byte("ServerName=test\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	params, _ := json.Marshal(map[string]any{"path": cfg})
	resp := (&Dispatcher{}).Handle(context.Background(), &rpc.Request{ID: "req-read-ok", Method: "file_read", Params: params}, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK, got %+v", resp.Error)
	}
	var got struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Content != "ServerName=test\n" {
		t.Fatalf("content = %q", got.Content)
	}
}

func TestFileReadStream_FollowsSymlinkThatStaysInsideRoot(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", root)
	target := filepath.Join(root, "SquadGame-real.log")
	if err := os.WriteFile(target, []byte("inside\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	link := filepath.Join(root, "SquadGame-alias.log")
	if err := os.Symlink("SquadGame-real.log", link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	params, _ := json.Marshal(map[string]any{"path": link})
	chunks, resp := collectStreamFrames(t, &Dispatcher{}, &rpc.Request{ID: "req-inside-link", Method: "file_read_stream", Params: params})
	if !resp.OK {
		t.Fatalf("expected OK for a symlink confined to the root, got %+v", resp.Error)
	}
	if len(chunks) != 1 || string(chunks[0]) != "inside\n" {
		t.Fatalf("chunks = %q", chunks)
	}
}

// A FIFO planted in a readable root used to block the bridge in open(2)
// forever; it must be refused immediately as a non-regular file.
func TestFileReadStream_RejectsFIFOWithoutBlocking(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", root)
	fifo := filepath.Join(root, "SquadGame-fifo.log")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}
	params, _ := json.Marshal(map[string]any{"path": fifo})
	type result struct {
		frames int
		resp   rpc.Response
	}
	done := make(chan result, 1)
	go func() {
		chunks, resp := collectStreamFrames(t, &Dispatcher{}, &rpc.Request{ID: "req-fifo", Method: "file_read_stream", Params: params})
		done <- result{len(chunks), resp}
	}()
	select {
	case r := <-done:
		if r.resp.OK || r.frames != 0 {
			t.Fatalf("expected a rejection for a FIFO, got ok=%v frames=%d", r.resp.OK, r.frames)
		}
		if r.resp.Error == nil || r.resp.Error.Code != rpc.CodeForbidden {
			t.Fatalf("expected CodeForbidden, got %+v", r.resp.Error)
		}
	case <-time.After(3 * time.Second):
		// Unblock the stuck open(2) so the goroutine can exit.
		if w, err := os.OpenFile(fifo, os.O_WRONLY, 0); err == nil {
			_ = w.Close()
		}
		t.Fatal("file_read_stream blocked opening a FIFO")
	}
}

// A cancelled connection context (client went away) must stop the stream
// instead of reading the rest of the file into a dead socket.
func TestFileReadStream_StopsWhenContextCancelled(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", root)
	logPath := filepath.Join(root, "SquadGame.log")
	if err := os.WriteFile(logPath, []byte(strings.Repeat("x", 64)), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	params, _ := json.Marshal(map[string]any{"path": logPath, "chunk_size": 8})
	frames := 0
	resp := (&Dispatcher{}).Handle(ctx, &rpc.Request{ID: "req-cancel", Method: "file_read_stream", Params: params}, func(rpc.StreamFrame) {
		frames++
		cancel()
	})
	if resp.OK {
		t.Fatalf("expected an error after cancellation, got success")
	}
	if frames != 1 {
		t.Fatalf("emitted %d frames after the context was cancelled, want 1", frames)
	}
}

func TestSquadLogList_DoesNotFollowSymlinkedLogsDir(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", root)
	outsideDir := t.TempDir()
	writeRetentionTestFile(t, filepath.Join(outsideDir, "SquadGame-host.log"), confinementSecret, time.Now())
	logsLink := filepath.Join(root, "Logs")
	if err := os.Symlink(outsideDir, logsLink); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	params, _ := json.Marshal(map[string]any{"path": logsLink})
	resp := (&Dispatcher{}).Handle(context.Background(), &rpc.Request{ID: "req-list-link", Method: "squad_log_list", Params: params}, func(rpc.StreamFrame) {})
	if resp.OK && strings.Contains(string(resp.Result), "SquadGame-host.log") {
		t.Fatalf("squad_log_list followed a symlinked Logs dir out of its root: %s", resp.Result)
	}
}

func TestSquadLogRetentionSweep_DoesNotFollowSymlinkedLogsDir(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	serverID := "019dbaa5-1234-7abc-8def-0123456789ab"
	savedRoot := t.TempDir()
	savedDir := filepath.Join(savedRoot, serverID, "SquadGame", "Saved")
	if err := os.MkdirAll(savedDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	outsideDir := t.TempDir()
	outsideLog := filepath.Join(outsideDir, "SquadGame-2026.06.01-12.00.00.log")
	writeRetentionTestFile(t, outsideLog, "foreign host log\n", now.Add(-60*24*time.Hour))
	if err := os.Symlink(outsideDir, filepath.Join(savedDir, "Logs")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	d := &Dispatcher{panelSavedRoot: savedRoot, nowFn: func() time.Time { return now }}
	resp := d.Handle(context.Background(), &rpc.Request{ID: "req-retention-link", Method: "squad_log_retention_sweep", Params: json.RawMessage(`{}`)}, func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("expected OK, got %+v", resp.Error)
	}
	var got struct {
		DeletedCount int `json:"deleted_count"`
		ErrorCount   int `json:"error_count"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	assertPathExists(t, outsideLog)
	if got.DeletedCount != 0 {
		t.Fatalf("deleted_count = %d, want 0", got.DeletedCount)
	}
	if got.ErrorCount != 1 {
		t.Fatalf("error_count = %d, want 1 (escaping Logs dir reported)", got.ErrorCount)
	}
}

func TestReadableTrustRoot_ConfinesEachAllowlistEntry(t *testing.T) {
	depot := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", depot)
	uuid := "019dbaa5-1234-7abc-8def-0123456789ab"
	cases := []struct {
		path, root, rel string
	}{
		{validate.PanelSavedRoot + "/" + uuid + "/SquadGame/Saved/Logs/SquadGame.log", validate.PanelSavedRoot + "/" + uuid, "SquadGame/Saved/Logs/SquadGame.log"},
		{validate.PanelSavedRoot + "/" + uuid, validate.PanelSavedRoot + "/" + uuid, "."},
		{validate.PanelConfigsRoot + "/" + uuid + "/ServerConfig/Server.cfg", validate.PanelConfigsRoot + "/" + uuid, "ServerConfig/Server.cfg"},
		{depot + "/ServerConfig/Server.cfg", depot, "ServerConfig/Server.cfg"},
		{"/var/lib/squad-panel/.first-owner-claimed", "/var/lib/squad-panel", ".first-owner-claimed"},
	}
	for _, c := range cases {
		root, rel, err := readableTrustRoot(c.path)
		if err != nil {
			t.Fatalf("readableTrustRoot(%q): %v", c.path, err)
		}
		if root != c.root || rel != c.rel {
			t.Fatalf("readableTrustRoot(%q) = (%q, %q), want (%q, %q)", c.path, root, rel, c.root, c.rel)
		}
	}
	if _, _, err := readableTrustRoot("/etc/shadow"); err == nil {
		t.Fatal("readableTrustRoot accepted a path outside every readable root")
	}
}

// A missing file must be reported with the structured not_found code so the
// API can tell "absent" from a real read failure without matching OS text
// (issue #37, finding #50).
func TestFileRead_MissingFileReturnsNotFound(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PANEL_DEPOT_HOST_PATH", root)
	params, _ := json.Marshal(map[string]any{"path": filepath.Join(root, "ServerConfig", "Server.cfg")})
	resp := (&Dispatcher{}).Handle(context.Background(), &rpc.Request{ID: "req-read-missing", Method: "file_read", Params: params}, func(rpc.StreamFrame) {})
	if resp.OK {
		t.Fatalf("expected an error for a missing file, got success: %s", resp.Result)
	}
	if resp.Error.Code != rpc.CodeNotFound {
		t.Fatalf("code = %q, want %q (message %q)", resp.Error.Code, rpc.CodeNotFound, resp.Error.Message)
	}
}
