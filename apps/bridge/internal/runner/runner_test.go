package runner

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRealRunEcho(t *testing.T) {
	r := Real{}
	stdout, stderr, exit, err := r.Run(context.Background(), "echo", []string{"hello"}, nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if exit != 0 {
		t.Fatalf("exit=%d want 0", exit)
	}
	if string(stdout) != "hello\n" {
		t.Fatalf("stdout=%q want %q", string(stdout), "hello\n")
	}
	if len(stderr) != 0 {
		t.Fatalf("stderr=%q want empty", string(stderr))
	}
}

func TestRealRunNonZeroExit(t *testing.T) {
	r := Real{}
	_, _, exit, err := r.Run(context.Background(), "sh", []string{"-c", "exit 42"}, nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if exit != 42 {
		t.Fatalf("exit=%d want 42", exit)
	}
}

func TestRealRunWithEnv(t *testing.T) {
	r := Real{}
	stdout, _, _, err := r.Run(context.Background(), "sh", []string{"-c", "echo $TEST_RUNNER_VAR"}, []string{"TEST_RUNNER_VAR=foobar"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if string(stdout) != "foobar\n" {
		t.Fatalf("stdout=%q want %q", string(stdout), "foobar\n")
	}
}

func TestRealStreamEcho(t *testing.T) {
	r := Real{}
	var captured []byte
	exit, err := r.Stream(context.Background(), "echo", []string{"streamed"}, nil,
		func(data []byte) { captured = append(captured, data...) },
		nil,
	)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if exit != 0 {
		t.Fatalf("exit=%d want 0", exit)
	}
	if string(captured) != "streamed\n" {
		t.Fatalf("captured=%q want %q", string(captured), "streamed\n")
	}
}

func TestRealStreamNilCallbacks(t *testing.T) {
	r := Real{}
	exit, err := r.Stream(context.Background(), "echo", []string{"x"}, nil, nil, nil)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if exit != 0 {
		t.Fatalf("exit=%d want 0", exit)
	}
}

func TestFakeRecordsCalls(t *testing.T) {
	f := &Fake{Stdout: []byte("out"), Stderr: []byte("err"), Exit: 1}
	stdout, stderr, exit, _ := f.Run(context.Background(), "cmd", []string{"a", "b"}, []string{"K=V"})
	if string(stdout) != "out" || string(stderr) != "err" || exit != 1 {
		t.Fatalf("unexpected fake result")
	}
	if len(f.Calls) != 1 {
		t.Fatalf("calls=%d want 1", len(f.Calls))
	}
	call := f.Calls[0]
	if call.Cmd != "cmd" {
		t.Fatalf("cmd=%q", call.Cmd)
	}
	if len(call.Args) != 2 || call.Args[0] != "a" || call.Args[1] != "b" {
		t.Fatalf("args=%v", call.Args)
	}
	if len(call.Env) != 1 || call.Env[0] != "K=V" {
		t.Fatalf("env=%v", call.Env)
	}
}

func TestFakeStreamCallsCallbacks(t *testing.T) {
	f := &Fake{Stdout: []byte("stream-out"), Stderr: []byte("stream-err")}
	var gotOut, gotErr []byte
	exit, _ := f.Stream(context.Background(), "s", nil, nil,
		func(data []byte) { gotOut = append(gotOut, data...) },
		func(data []byte) { gotErr = append(gotErr, data...) },
	)
	if exit != 0 {
		t.Fatalf("exit=%d", exit)
	}
	if string(gotOut) != "stream-out" {
		t.Fatalf("stdout=%q", string(gotOut))
	}
	if string(gotErr) != "stream-err" {
		t.Fatalf("stderr=%q", string(gotErr))
	}
}

func TestFakeOnRunCallback(t *testing.T) {
	var capturedCall FakeCall
	f := &Fake{OnRun: func(c FakeCall) { capturedCall = c }}
	_, _, _, _ = f.Run(context.Background(), "docker", []string{"ps"}, nil)
	if capturedCall.Cmd != "docker" {
		t.Fatalf("OnRun not called or wrong cmd=%q", capturedCall.Cmd)
	}
}

func TestRunnerInterfaceCompliance(t *testing.T) {
	var _ Runner = Real{}
	var _ Runner = &Fake{}
}

// Regression for #74 (finding #420): a cancelled or timed-out command was
// reported as an ordinary non-zero exit with err == nil, so callers could not
// tell a timeout from a failing command.
func TestRealRunReportsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, _, _, err := Real{}.Run(ctx, "sleep", []string{"30"}, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context.DeadlineExceeded, got %v", err)
	}
}

func TestRealStreamReportsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := Real{}.Stream(ctx, "sleep", []string{"30"}, nil, nil, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context.DeadlineExceeded, got %v", err)
	}
}

// Regression for #74 (finding #420): cancelling Stream killed only the direct
// child. A grandchild (e.g. the docker CLI started by restore.sh) kept the
// stdout/stderr pipes open, so Stream blocked until it exited on its own and
// the work carried on orphaned. The whole process group must die.
func TestRealStreamCancellationKillsDescendants(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := Real{}.Stream(ctx, "sh", []string{"-c", "sleep 30 & wait"}, nil, nil, nil)
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("Stream returned after %s; cancellation did not reach the grandchild", elapsed)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context.DeadlineExceeded, got %v", err)
	}
}

// A descendant that escapes the process group (setsid) still cannot hold
// Stream hostage after cancellation: the pipes are force-closed after
// streamWaitDelay.
func TestRealStreamCancellationDoesNotWaitForEscapedDescendant(t *testing.T) {
	prev := streamWaitDelay
	streamWaitDelay = 200 * time.Millisecond
	t.Cleanup(func() { streamWaitDelay = prev })
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, _ = Real{}.Stream(ctx, "sh", []string{"-c", "setsid sleep 3 & sleep 30"}, nil, nil, nil)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("Stream returned after %s; escaped descendant held the pipes", elapsed)
	}
}
