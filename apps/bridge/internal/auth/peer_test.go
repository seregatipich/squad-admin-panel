package auth

import (
	"errors"
	"net"
	"path/filepath"
	"testing"
)

func TestErrUntrustedPeerSentinel(t *testing.T) {
	if !errors.Is(ErrUntrustedPeer, ErrUntrustedPeer) {
		t.Fatal("ErrUntrustedPeer must match itself via errors.Is")
	}
	wrapped := errors.New("wrapped: " + ErrUntrustedPeer.Error())
	if errors.Is(wrapped, ErrUntrustedPeer) {
		t.Fatal("non-wrapped error must not match ErrUntrustedPeer")
	}
}

func TestPeerGroupDefault(t *testing.T) {
	if PeerGroup != "panel" {
		t.Fatalf("PeerGroup=%q want %q", PeerGroup, "panel")
	}
}

func TestPeerStructZeroValue(t *testing.T) {
	var p Peer
	if p.InGroup {
		t.Fatal("zero-value Peer must have InGroup=false")
	}
	if p.PID != 0 || p.UID != 0 || p.GID != 0 {
		t.Fatal("zero-value Peer must have zeroed IDs")
	}
	if p.User != "" {
		t.Fatal("zero-value Peer must have empty User")
	}
}

// Regression for #45 (finding #383): ResolvePeer must return a non-nil Peer on
// every error path so callers can log the rejected identity without a nil
// dereference.
func TestResolvePeerClosedConnReturnsNonNilPeer(t *testing.T) {
	addr := &net.UnixAddr{Name: filepath.Join(t.TempDir(), "peer.sock"), Net: "unix"}
	l, err := net.ListenUnix("unix", addr)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer l.Close()
	client, err := net.DialUnix("unix", nil, addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	server, err := l.AcceptUnix()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	_ = server.Close()

	peer, err := ResolvePeer(server)
	if err == nil {
		t.Fatal("ResolvePeer on a closed conn must fail")
	}
	if peer == nil {
		t.Fatal("ResolvePeer must return a non-nil Peer alongside the error")
	}
	if peer.InGroup {
		t.Fatal("a peer that could not be resolved must not be trusted")
	}
}
