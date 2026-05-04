package validate

import (
	"errors"
	"fmt"
	"testing"
)

func TestErrInvalidArgsSentinel(t *testing.T) {
	if ErrInvalidArgs == nil {
		t.Fatal("ErrInvalidArgs must not be nil")
	}
	if ErrInvalidArgs.Error() != "invalid arguments" {
		t.Fatalf("message=%q want %q", ErrInvalidArgs.Error(), "invalid arguments")
	}
}

func TestErrInvalidArgsWrapping(t *testing.T) {
	wrapped := fmt.Errorf("port check: %w", ErrInvalidArgs)
	if !errors.Is(wrapped, ErrInvalidArgs) {
		t.Fatal("wrapped error must match ErrInvalidArgs via errors.Is")
	}
}

func TestErrInvalidArgsDistinctFromOther(t *testing.T) {
	other := errors.New("invalid arguments")
	if errors.Is(other, ErrInvalidArgs) {
		t.Fatal("a fresh error with same text must not match ErrInvalidArgs")
	}
}
