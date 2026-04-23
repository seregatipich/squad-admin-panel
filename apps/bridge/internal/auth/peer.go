// Package auth resolves peer credentials on a Unix domain socket
// connection. Every connection we accept must come from a UID that
// belongs to the "panel" system group.
package auth

import (
	"errors"
	"fmt"
	"net"
	"os/user"
	"strconv"

	"golang.org/x/sys/unix"
)

// ErrUntrustedPeer is returned when the calling user is not in the
// configured group.
var ErrUntrustedPeer = errors.New("untrusted peer")

// PeerGroup defaults to "panel"; it can be overridden by the daemon
// main for tests.
var PeerGroup = "panel"

// Peer captures the identity we resolved for a given connection.
type Peer struct {
	PID     int32
	UID     uint32
	GID     uint32
	User    string
	InGroup bool
}

// ResolvePeer calls getsockopt(SO_PEERCRED) and looks up whether the UID
// is a member of PeerGroup. Returns ErrUntrustedPeer if not.
func ResolvePeer(conn *net.UnixConn) (*Peer, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return nil, fmt.Errorf("syscallconn: %w", err)
	}

	var creds *unix.Ucred
	var sockErr error
	controlErr := raw.Control(func(fd uintptr) {
		creds, sockErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	})
	if controlErr != nil {
		return nil, fmt.Errorf("control: %w", controlErr)
	}
	if sockErr != nil {
		return nil, fmt.Errorf("getsockopt SO_PEERCRED: %w", sockErr)
	}

	var username string
	u, lookupErr := user.LookupId(strconv.FormatUint(uint64(creds.Uid), 10))
	if lookupErr == nil {
		username = u.Username
	}

	target, err := user.LookupGroup(PeerGroup)
	if err != nil {
		return &Peer{
				PID:  creds.Pid,
				UID:  creds.Uid,
				GID:  creds.Gid,
				User: username,
			},
			fmt.Errorf("lookup group %q: %w", PeerGroup, err)
	}

	if strconv.FormatUint(uint64(creds.Gid), 10) == target.Gid {
		return &Peer{
			PID:     creds.Pid,
			UID:     creds.Uid,
			GID:     creds.Gid,
			User:    username,
			InGroup: true,
		}, nil
	}

	if u != nil {
		if groups, err := u.GroupIds(); err == nil {
			for _, gid := range groups {
				if gid == target.Gid {
					return &Peer{
						PID:     creds.Pid,
						UID:     creds.Uid,
						GID:     creds.Gid,
						User:    username,
						InGroup: true,
					}, nil
				}
			}
		}
	}

	return &Peer{
			PID:  creds.Pid,
			UID:  creds.Uid,
			GID:  creds.Gid,
			User: username,
		},
		ErrUntrustedPeer
}
