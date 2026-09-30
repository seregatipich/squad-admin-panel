package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/rpc"
)

func TestWriteErrorProducesValidFrame(t *testing.T) {
	var buf fakeWriter
	writeError(&buf, "req-1", rpc.CodeForbidden, "access denied")
	if len(buf.data) == 0 {
		t.Fatal("writeError produced no output")
	}
	frame, err := rpc.ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame failed: %v", err)
	}
	var resp rpc.Response
	if err := json.Unmarshal(frame, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.OK {
		t.Fatal("expected OK=false for error response")
	}
	if resp.Error == nil {
		t.Fatal("Error field must be non-nil")
	}
	if resp.Error.Code != rpc.CodeForbidden {
		t.Fatalf("code=%q want %q", resp.Error.Code, rpc.CodeForbidden)
	}
	if resp.Error.Message != "access denied" {
		t.Fatalf("message=%q want %q", resp.Error.Message, "access denied")
	}
	if resp.ID != "req-1" {
		t.Fatalf("id=%q want %q", resp.ID, "req-1")
	}
}

func TestWatchdogExitsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		watchdog(ctx, time.Hour)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("watchdog did not exit after context cancel")
	}
}

func TestPickListenerFallback(t *testing.T) {
	sock := t.TempDir() + "/test-bridge.sock"
	t.Setenv("PANEL_BRIDGE_SOCK", sock)
	l, err := pickListener()
	if err != nil {
		t.Fatalf("pickListener: %v", err)
	}
	defer l.Close()
	if l.Addr().String() != sock {
		t.Fatalf("addr=%q want %q", l.Addr().String(), sock)
	}
}

type fakeWriter struct {
	data []byte
}

func (f *fakeWriter) Write(p []byte) (int, error) {
	f.data = append(f.data, p...)
	return len(p), nil
}

func (f *fakeWriter) Read(p []byte) (int, error) {
	n := copy(p, f.data)
	f.data = f.data[n:]
	return n, nil
}

// Regression for #74 (finding #389): the development fallback used to delete
// whatever sat at the socket path, silently stealing the socket of a bridge
// instance that was already serving there.
func TestPickListenerFallback_RefusesToStealLiveSocket(t *testing.T) {
	sock := t.TempDir() + "/live-bridge.sock"
	live, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer live.Close()
	t.Setenv("PANEL_BRIDGE_SOCK", sock)

	if l, err := pickListener(); err == nil {
		_ = l.Close()
		t.Fatal("pickListener must refuse a socket path another listener is serving")
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatalf("the live listener's socket was removed: %v", err)
	}
	_ = conn.Close()
}

func TestPickListenerFallback_ReplacesStaleSocketFile(t *testing.T) {
	sock := t.TempDir() + "/stale-bridge.sock"
	stale, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	stale.(*net.UnixListener).SetUnlinkOnClose(false)
	_ = stale.Close()
	t.Setenv("PANEL_BRIDGE_SOCK", sock)

	l, err := pickListener()
	if err != nil {
		t.Fatalf("pickListener over a stale socket file: %v", err)
	}
	_ = l.Close()
}

// The fallback socket must never be reachable by other users, not even in
// the window between listen(2) and a later chmod.
func TestPickListenerFallback_CreatesSocketWithoutOtherAccess(t *testing.T) {
	sock := t.TempDir() + "/mode-bridge.sock"
	t.Setenv("PANEL_BRIDGE_SOCK", sock)
	prev := syscall.Umask(0)
	defer syscall.Umask(prev)

	l, err := pickListener()
	if err != nil {
		t.Fatalf("pickListener: %v", err)
	}
	defer l.Close()
	st, err := os.Stat(sock)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := st.Mode().Perm(); perm != 0o660 {
		t.Fatalf("socket mode=%o want 660", perm)
	}
}

// Regression for #74 (finding #388): the watchdog pinged on a hard-coded 10 s
// period regardless of the unit's WatchdogSec; it must follow the interval
// systemd advertises via WATCHDOG_USEC (pinging at half of it).
func TestWatchdogInterval_FollowsSystemdWatchdogUsec(t *testing.T) {
	t.Setenv("WATCHDOG_USEC", "30000000")
	t.Setenv("WATCHDOG_PID", strconv.Itoa(os.Getpid()))
	interval, enabled := watchdogInterval()
	if !enabled {
		t.Fatal("watchdog must be enabled when systemd sets WATCHDOG_USEC for this pid")
	}
	if interval != 15*time.Second {
		t.Fatalf("interval=%s want 15s", interval)
	}
}

func TestWatchdogInterval_DisabledWithoutSystemd(t *testing.T) {
	t.Setenv("WATCHDOG_USEC", "")
	t.Setenv("WATCHDOG_PID", "")
	if _, enabled := watchdogInterval(); enabled {
		t.Fatal("watchdog must be disabled when systemd did not request it")
	}
}
