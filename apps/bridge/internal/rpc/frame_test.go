package rpc

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	cases := []string{
		`{}`,
		`{"hello":"world"}`,
		`{"a":"` + string(make([]byte, 512)) + `"}`,
	}
	for _, c := range cases {
		var buf bytes.Buffer
		if err := WriteFrame(&buf, []byte(c)); err != nil {
			t.Fatalf("WriteFrame: %v", err)
		}
		got, err := ReadFrame(&buf)
		if err != nil {
			t.Fatalf("ReadFrame: %v", err)
		}
		if string(got) != c {
			t.Fatalf("roundtrip mismatch: got %q want %q", got, c)
		}
	}
}

func TestEmptyFrame(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, []byte{}); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}
	got, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty frame, got %d bytes", len(got))
	}
}

func TestRejectsOversizedFrame(t *testing.T) {
	over := make([]byte, MaxFrame+1)
	var buf bytes.Buffer
	err := WriteFrame(&buf, over)
	if !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("expected ErrFrameTooLarge, got %v", err)
	}

	// Same from the read side: construct an oversized header manually.
	buf.Reset()
	buf.Write([]byte{0xff, 0xff, 0xff, 0xff}) // uint32 max
	_, err = ReadFrame(&buf)
	if !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("expected ErrFrameTooLarge from ReadFrame, got %v", err)
	}
}

func TestEOFPartialFrame(t *testing.T) {
	// Header declaring 10 bytes, but stream only has 3.
	r := bytes.NewReader([]byte{0, 0, 0, 10, 'a', 'b', 'c'})
	_, err := ReadFrame(r)
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected ErrUnexpectedEOF, got %v", err)
	}
}

// countingWriter records every Write call so a test can assert how a frame
// reached the underlying connection.
type countingWriter struct {
	writes [][]byte
}

func (w *countingWriter) Write(p []byte) (int, error) {
	w.writes = append(w.writes, append([]byte(nil), p...))
	return len(p), nil
}

// Regression for #74 (finding #414): WriteFrame issued the 4-byte header and
// the payload as two Write calls, so a concurrent writer on the same
// connection could land its frame between them and desynchronise the stream.
// A net.Conn holds its fd write lock for one whole Write, so a single Write
// makes each frame atomic against other writers.
func TestWriteFrame_EmitsHeaderAndPayloadInOneWrite(t *testing.T) {
	var w countingWriter
	if err := WriteFrame(&w, []byte(`{"id":"1"}`)); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}
	if len(w.writes) != 1 {
		t.Fatalf("WriteFrame made %d Write calls, want exactly 1", len(w.writes))
	}
	got, err := ReadFrame(bytes.NewReader(w.writes[0]))
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if string(got) != `{"id":"1"}` {
		t.Fatalf("payload=%q", got)
	}
}
