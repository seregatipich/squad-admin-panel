package auth

import (
	"errors"
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
