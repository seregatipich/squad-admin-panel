// Command panel-host-bridge serves privileged operations on behalf of
// the containerised panel over a unix domain socket. It runs as root (see
// deploy/panel-host-bridge.service) and uses systemd socket activation so
// systemd owns the socket: its path, ownership and inode stay stable across
// daemon restarts, and connections queue while the daemon is restarting.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"os/user"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/coreos/go-systemd/v22/activation"
	"github.com/coreos/go-systemd/v22/daemon"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/auth"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/handlers"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/metrics"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/runner"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/sysd"
)

// Version is baked in by the build.
var Version = "dev"

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)
	handlers.Version = Version

	listener, err := pickListener()
	if err != nil {
		log.Error("listen", "err", err)
		os.Exit(1)
	}
	log.Info("panel-host-bridge listening",
		"version", Version,
		"addr", listener.Addr().String(),
	)

	_, _ = daemon.SdNotify(false, daemon.SdNotifyReady)

	disp := &handlers.Dispatcher{
		UFW:          &sysd.UFW{R: runner.Real{}},
		Docker:       runner.NewDocker(runner.Real{}),
		MetricsCache: metrics.NewMetricsCache(nil, nil, 200*time.Millisecond),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if interval, enabled := watchdogInterval(); enabled {
		go watchdog(ctx, interval)
	}

	// Shutdown on SIGTERM/SIGINT.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigs
		handlers.DiagLog("bridge", "bridge.signal.sigterm", "info", "shutdown signal received", map[string]any{
			"signal":  sig.String(),
			"version": Version,
		})
		log.Info("shutdown signal received", "signal", sig.String())
		// Tell systemd right away that we are stopping, not only after every
		// connection has drained, so the unit reports "deactivating" while it
		// waits instead of looking healthy.
		_, _ = daemon.SdNotify(false, daemon.SdNotifyStopping)
		_ = listener.Close()
		cancel()
	}()

	var wg sync.WaitGroup
	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				break
			}
			log.Warn("accept", "err", err)
			continue
		}
		unix, ok := conn.(*net.UnixConn)
		if !ok {
			log.Warn("unexpected conn type", "type", fmt.Sprintf("%T", conn))
			_ = conn.Close()
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			serveConn(ctx, log, unix, disp)
		}()
	}

	wg.Wait()
}

func pickListener() (net.Listener, error) {
	listeners, err := activation.Listeners()
	if err != nil {
		return nil, fmt.Errorf("systemd activation: %w", err)
	}
	if len(listeners) >= 1 {
		return listeners[0], nil
	}
	// Fallback for local development, when no .socket unit handed us a
	// listener. Production always runs socket-activated.
	sock := os.Getenv("PANEL_BRIDGE_SOCK")
	if sock == "" {
		sock = "/run/panel-host-bridge/bridge.sock"
	}
	slog.Warn("no systemd socket activation; using development socket fallback", "sock", sock)
	if err := removeStaleSocket(sock); err != nil {
		return nil, err
	}
	// Create the socket 0660 directly (umask 0117 on the default 0777) so it
	// is never reachable by other users, not even before a chmod could run.
	// The umask is process-wide, which is safe here: this runs once at
	// startup before any other goroutine creates files.
	prevUmask := syscall.Umask(0o117)
	l, err := net.Listen("unix", sock)
	syscall.Umask(prevUmask)
	if err != nil {
		return nil, fmt.Errorf("listen %q: %w", sock, err)
	}
	// Best effort, mirroring the production .socket unit: a non-root
	// developer usually cannot chgrp to the panel group.
	if g, err := user.LookupGroup(auth.PeerGroup); err == nil {
		if gid, err := strconv.Atoi(g.Gid); err == nil {
			_ = os.Chown(sock, -1, gid)
		}
	}
	return l, nil
}

// removeStaleSocket clears a socket file left behind by a previous bridge
// process so the development fallback can listen again. It refuses to touch
// a path that is not a socket, or a socket that another listener is still
// serving (a successful probe dial), instead of silently stealing it.
func removeStaleSocket(sock string) error {
	st, err := os.Lstat(sock)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("stat %q: %w", sock, err)
	}
	if st.Mode().Type() != fs.ModeSocket {
		return fmt.Errorf("%q exists and is not a socket", sock)
	}
	if conn, err := net.DialTimeout("unix", sock, time.Second); err == nil {
		_ = conn.Close()
		return fmt.Errorf("socket %q is already served by another listener", sock)
	}
	if err := os.Remove(sock); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove stale socket %q: %w", sock, err)
	}
	return nil
}

// watchdogInterval reports how often to ping the systemd watchdog: half of
// the WatchdogSec= systemd advertises through WATCHDOG_USEC/WATCHDOG_PID, the
// margin sd_watchdog_enabled(3) recommends. enabled is false when systemd
// did not request watchdog pings for this process.
func watchdogInterval() (interval time.Duration, enabled bool) {
	timeout, err := daemon.SdWatchdogEnabled(false)
	if err != nil || timeout <= 0 {
		return 0, false
	}
	return timeout / 2, true
}

// watchdog pings the systemd watchdog every interval until ctx is cancelled.
func watchdog(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, _ = daemon.SdNotify(false, daemon.SdNotifyWatchdog)
		}
	}
}

// serveConn authenticates one client connection via SO_PEERCRED and then
// dispatches its requests until the client disconnects or ctx is cancelled.
// A panic while serving one connection is recovered and logged so it cannot
// take down the root daemon and every other in-flight operation with it.
func serveConn(ctx context.Context, log *slog.Logger, conn *net.UnixConn, disp *handlers.Dispatcher) {
	defer conn.Close()
	defer func() {
		if r := recover(); r != nil {
			log.Error("serveConn panic recovered", "panic", r)
		}
	}()

	// On shutdown (SIGTERM → ctx.Done()) close the conn so the blocking
	// ReadFrame returns net.ErrClosed and serveConn unwinds. Without this
	// the bridge sits in `deactivating` for the full TimeoutStopSec because
	// the api keeps the connection open across restarts.
	closerDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-closerDone:
		}
	}()
	defer close(closerDone)

	peer, err := auth.ResolvePeer(conn)
	if err != nil {
		log.Warn("rejected untrusted peer",
			"err", err, "uid", peer.UID, "user", peer.User, "pid", peer.PID)
		handlers.DiagLog("bridge", "bridge.client.disconnected", "warn", "peer rejected — not in panel group", map[string]any{
			"reason": "untrusted_peer",
			"uid":    peer.UID,
			"pid":    peer.PID,
			"user":   peer.User,
			"err":    err.Error(),
		})
		writeError(conn, "", rpc.CodeForbidden, "caller is not in the 'panel' group")
		return
	}
	log.Info("peer connected", "uid", peer.UID, "pid", peer.PID, "user", peer.User)
	handlers.DiagLog("bridge", "bridge.client.connected", "info", "panel peer connected", map[string]any{
		"uid":  peer.UID,
		"pid":  peer.PID,
		"user": peer.User,
	})
	disconnectReason := "eof"
	defer func() {
		handlers.DiagLog("bridge", "bridge.client.disconnected", "info", "panel peer disconnected", map[string]any{
			"reason": disconnectReason,
			"uid":    peer.UID,
			"pid":    peer.PID,
			"user":   peer.User,
		})
	}()

	// connCtx scopes every request on this connection. It is cancelled when
	// the client goes away (EOF / read error) or a response can no longer be
	// written, so streaming handlers (container_logs_follow, file_read_stream)
	// stop and their child processes are killed instead of running until the
	// container stops. The API cancels a follow by ending its dedicated
	// connection, so this is the only cancellation signal it has.
	connCtx, connCancel := context.WithCancel(ctx)

	// Every frame on this connection goes through writeMu so concurrent
	// handlers never interleave their output.
	var writeMu sync.Mutex
	writeFrame := func(payload []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := rpc.WriteFrame(conn, payload); err != nil {
			log.Warn("write frame failed; closing connection", "err", err, "pid", peer.PID)
			connCancel()
		}
	}
	writeResp := func(resp rpc.Response) {
		payload, err := encodeResponse(resp)
		if err != nil {
			log.Warn("response replaced by an error response", "id", resp.ID, "err", err)
		}
		writeFrame(payload)
	}
	writeStream := func(sf rpc.StreamFrame) {
		payload, err := json.Marshal(sf)
		if err == nil && len(payload) > rpc.MaxFrame {
			err = rpc.ErrFrameTooLarge
		}
		if err != nil {
			// A dropped frame would silently corrupt the stream, so end the
			// connection; the caller sees the disconnect instead of a gap.
			log.Warn("stream frame not sendable; closing connection", "id", sf.ID, "err", err)
			connCancel()
			return
		}
		writeFrame(payload)
	}

	// Each request runs in its own goroutine so a long-running streaming
	// method (container_logs_follow, depot_update) cannot block other
	// requests that arrive on the same connection while it streams. writeMu
	// keeps the wire output frame-aligned when multiple calls interleave.
	// Deferred calls run LIFO: connCancel below fires before inflight.Wait,
	// so in-flight handlers are cancelled before serveConn waits for them.
	reader := bufio.NewReader(conn)
	var inflight sync.WaitGroup
	defer inflight.Wait()
	defer connCancel()
	for {
		payload, err := rpc.ReadFrame(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				disconnectReason = "eof"
				return
			}
			if errors.Is(err, net.ErrClosed) {
				disconnectReason = "shutdown"
				return
			}
			log.Warn("read frame", "err", err)
			disconnectReason = "read_frame_error"
			return
		}
		var req rpc.Request
		if err := json.Unmarshal(payload, &req); err != nil {
			writeResp(rpc.NewErrorResponse("", rpc.CodeInvalidArgs, "invalid JSON: "+err.Error()))
			continue
		}
		inflight.Add(1)
		go func(req rpc.Request) {
			defer inflight.Done()
			resp := disp.Handle(connCtx, &req, writeStream)
			writeResp(resp)
		}(req)
	}
}

// encodeResponse marshals resp for the wire. When resp cannot be encoded, or
// its encoding exceeds rpc.MaxFrame, it returns a compact error Response for
// the same id instead, together with the reason, so the caller always gets an
// answer rather than waiting for its RPC timeout.
func encodeResponse(resp rpc.Response) ([]byte, error) {
	payload, err := json.Marshal(resp)
	if err != nil {
		fallback, _ := json.Marshal(rpc.NewErrorResponse(resp.ID, rpc.CodeInternal, "encode response: "+err.Error()))
		return fallback, fmt.Errorf("encode response: %w", err)
	}
	if len(payload) > rpc.MaxFrame {
		msg := fmt.Sprintf("response of %d bytes exceeds the %d-byte frame limit", len(payload), rpc.MaxFrame)
		fallback, _ := json.Marshal(rpc.NewErrorResponse(resp.ID, rpc.CodeRuntimeError, msg))
		return fallback, fmt.Errorf("%w: %s", rpc.ErrFrameTooLarge, msg)
	}
	return payload, nil
}

// writeError writes a single error Response frame. It is only safe before
// any request goroutine of the connection has started (no writeMu).
func writeError(w io.Writer, id, code, msg string) {
	payload, _ := json.Marshal(rpc.NewErrorResponse(id, code, msg))
	_ = rpc.WriteFrame(w, payload)
}
