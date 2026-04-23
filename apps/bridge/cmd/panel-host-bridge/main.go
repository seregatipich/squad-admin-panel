// Command panel-host-bridge serves privileged operations on behalf of
// the containerised panel over a unix domain socket. It uses systemd
// socket activation so it can stay unprivileged at restart and let
// systemd own the socket lifecycle.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/coreos/go-systemd/v22/activation"
	"github.com/coreos/go-systemd/v22/daemon"

	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/auth"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/handlers"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/pkgmgr"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/runner"
	"github.com/breaking-squad/squad-admin-panel/apps/bridge/internal/sysd"
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
		APT:     &pkgmgr.APT{R: runner.Real{}},
		Systemd: &sysd.Client{R: runner.Real{}},
		UFW:     &sysd.UFW{R: runner.Real{}},
		Steam:   &runner.SteamCMD{R: runner.Real{}},
		R:       runner.Real{},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Watchdog ping every 10 s keeps systemd happy.
	go watchdog(ctx)

	// Shutdown on SIGTERM/SIGINT.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigs
		log.Info("shutdown signal received")
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
	_, _ = daemon.SdNotify(false, daemon.SdNotifyStopping)
}

func pickListener() (net.Listener, error) {
	listeners, err := activation.Listeners()
	if err != nil {
		return nil, fmt.Errorf("systemd activation: %w", err)
	}
	if len(listeners) >= 1 {
		return listeners[0], nil
	}
	// Fallback for local development.
	sock := os.Getenv("PANEL_BRIDGE_SOCK")
	if sock == "" {
		sock = "/run/panel-host-bridge.sock"
	}
	_ = os.Remove(sock)
	l, err := net.Listen("unix", sock)
	if err != nil {
		return nil, fmt.Errorf("listen %q: %w", sock, err)
	}
	if err := os.Chmod(sock, 0o660); err != nil {
		return nil, fmt.Errorf("chmod %q: %w", sock, err)
	}
	return l, nil
}

func watchdog(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Second):
			_, _ = daemon.SdNotify(false, daemon.SdNotifyWatchdog)
		}
	}
}

func serveConn(ctx context.Context, log *slog.Logger, conn *net.UnixConn, disp *handlers.Dispatcher) {
	defer conn.Close()

	peer, err := auth.ResolvePeer(conn)
	if err != nil {
		log.Warn("rejected untrusted peer",
			"err", err, "uid", peer.UID, "user", peer.User, "pid", peer.PID)
		writeError(conn, "", rpc.CodeForbidden, "caller is not in the 'panel' group")
		return
	}
	log.Info("peer connected", "uid", peer.UID, "pid", peer.PID, "user", peer.User)

	var writeMu sync.Mutex
	writeResp := func(resp rpc.Response) {
		payload, err := json.Marshal(resp)
		if err != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = rpc.WriteFrame(conn, payload)
	}
	writeStream := func(sf rpc.StreamFrame) {
		payload, err := json.Marshal(sf)
		if err != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = rpc.WriteFrame(conn, payload)
	}

	for {
		payload, err := rpc.ReadFrame(bufio.NewReader(conn))
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			log.Warn("read frame", "err", err)
			return
		}
		var req rpc.Request
		if err := json.Unmarshal(payload, &req); err != nil {
			writeError(conn, "", rpc.CodeInvalidArgs, "invalid JSON: "+err.Error())
			continue
		}
		resp := disp.Handle(ctx, &req, writeStream)
		writeResp(resp)
	}
}

func writeError(w io.Writer, id, code, msg string) {
	payload, _ := json.Marshal(rpc.NewErrorResponse(id, code, msg))
	_ = rpc.WriteFrame(w, payload)
}
