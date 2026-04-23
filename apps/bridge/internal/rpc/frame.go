// Package rpc implements the panel-host-bridge wire protocol:
// a 4-byte big-endian length prefix followed by a JSON payload.
package rpc

import (
	"encoding/binary"
	"errors"
	"io"
)

// MaxFrame is the largest single payload we will send or accept.
// 16 MiB accommodates file_read of Squad server logs (up to 10 MiB) plus
// envelope overhead, while keeping memory pressure bounded.
const MaxFrame = 16 << 20

// ErrFrameTooLarge is returned when a peer declares a length greater than MaxFrame.
var ErrFrameTooLarge = errors.New("rpc: frame exceeds maximum size")

// ReadFrame reads one length-prefixed JSON frame from r.
// It returns io.EOF cleanly when the peer closes mid-frame.
func ReadFrame(r io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 {
		return []byte{}, nil
	}
	if size > MaxFrame {
		return nil, ErrFrameTooLarge
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// WriteFrame writes a single length-prefixed frame.
// Payloads larger than MaxFrame are rejected.
func WriteFrame(w io.Writer, payload []byte) error {
	if len(payload) > MaxFrame {
		return ErrFrameTooLarge
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	_, err := w.Write(payload)
	return err
}
