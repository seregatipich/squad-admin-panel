// Package rpc implements the panel-host-bridge wire protocol:
// a 4-byte big-endian length prefix followed by a JSON payload.
package rpc

import (
	"encoding/binary"
	"errors"
	"io"
)

// MaxFrame is the largest single payload we will send or accept, bounding
// memory per frame. It caps the ENCODED frame, not the data inside it: a
// file_read of a file under the 10 MiB read cap can still exceed it once JSON
// escaping expands '<', '>', '&', control bytes and invalid UTF-8 (up to six
// bytes each). The daemon answers such an oversized response with an error
// Response instead of dropping it; callers that need large files use the
// chunked file_read_stream method.
const MaxFrame = 16 << 20

// ErrFrameTooLarge is returned when a peer declares a length greater than MaxFrame.
var ErrFrameTooLarge = errors.New("rpc: frame exceeds maximum size")

// ReadFrame reads one length-prefixed JSON frame from r.
// It returns io.EOF when the peer closes cleanly on a frame boundary, and
// io.ErrUnexpectedEOF when the stream ends in the middle of a frame.
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
// Payloads larger than MaxFrame are rejected with ErrFrameTooLarge.
//
// The header and payload are assembled into one buffer and written with a
// single Write: net.Conn holds its fd write lock for the whole call, so a
// frame can never be split by another goroutine writing to the same
// connection.
func WriteFrame(w io.Writer, payload []byte) error {
	if len(payload) > MaxFrame {
		return ErrFrameTooLarge
	}
	frame := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(frame[:4], uint32(len(payload)))
	copy(frame[4:], payload)
	_, err := w.Write(frame)
	return err
}
