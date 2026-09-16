package main

import (
	"context"
	"encoding/json"
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
		watchdog(ctx)
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
