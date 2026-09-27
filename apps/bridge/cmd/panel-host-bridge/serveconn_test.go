package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"os/user"
	"path/filepath"
	"testing"
	"time"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/auth"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/handlers"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/runner"
)

// blockingStreamRunner stands in for `docker logs --follow`: Stream blocks
// until its context is cancelled, exactly like the real process which only
// exits when the container stops or its context kills it.
type blockingStreamRunner struct {
	started   chan struct{}
	cancelled chan struct{}
}

func (r *blockingStreamRunner) Run(context.Context, string, []string, []string) ([]byte, []byte, int, error) {
	return nil, nil, 0, nil
}

func (r *blockingStreamRunner) Stream(ctx context.Context, _ string, _ []string, _ []string, onStdout, _ func([]byte)) (int, error) {
	onStdout([]byte("line\n"))
	close(r.started)
	<-ctx.Done()
	close(r.cancelled)
	return -1, ctx.Err()
}

// trustCurrentUser points the SO_PEERCRED group check at the test process's
// primary group so serveConn accepts the in-process client.
func trustCurrentUser(t *testing.T) {
	t.Helper()
	u, err := user.Current()
	if err != nil {
		t.Fatalf("current user: %v", err)
	}
	g, err := user.LookupGroupId(u.Gid)
	if err != nil {
		t.Fatalf("lookup primary group: %v", err)
	}
	prev := auth.PeerGroup
	auth.PeerGroup = g.Name
	t.Cleanup(func() { auth.PeerGroup = prev })
}

// connectedPair returns both ends of a real Unix-socket connection so
// serveConn can resolve SO_PEERCRED on its end.
func connectedPair(t *testing.T) (server, client *net.UnixConn) {
	t.Helper()
	addr := &net.UnixAddr{Name: filepath.Join(t.TempDir(), "bridge.sock"), Net: "unix"}
	l, err := net.ListenUnix("unix", addr)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer l.Close()
	client, err = net.DialUnix("unix", nil, addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	server, err = l.AcceptUnix()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return server, client
}

// Regression for #13 (finding #382): a streaming RPC must be cancelled when
// the client goes away. The API cancels container_logs_follow by ending its
// dedicated connection (socket.end() — a half-close), so EOF on the read side
// has to cancel the in-flight handler and let serveConn return; otherwise the
// root-owned `docker logs --follow` process leaks until the container stops.
func TestServeConn_ClientDisconnectCancelsStreamingRPC(t *testing.T) {
	trustCurrentUser(t)
	fake := &blockingStreamRunner{started: make(chan struct{}), cancelled: make(chan struct{})}
	disp := &handlers.Dispatcher{Docker: runner.NewDocker(fake)}
	server, client := connectedPair(t)

	done := make(chan struct{})
	go func() {
		defer close(done)
		serveConn(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), server, disp)
	}()

	params, _ := json.Marshal(map[string]any{"name": "squad-019dbaa5-1234-7abc-8def-0123456789ab", "tail": 10})
	payload, _ := json.Marshal(rpc.Request{ID: "follow-1", Method: "container_logs_follow", Params: params})
	if err := rpc.WriteFrame(client, payload); err != nil {
		t.Fatalf("write request: %v", err)
	}
	select {
	case <-fake.started:
	case <-time.After(5 * time.Second):
		t.Fatal("container_logs_follow never started streaming")
	}

	if err := client.CloseWrite(); err != nil {
		t.Fatalf("half-close client: %v", err)
	}

	select {
	case <-fake.cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("streaming handler context was not cancelled after the client disconnected")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("serveConn did not return after the client disconnected")
	}
}
