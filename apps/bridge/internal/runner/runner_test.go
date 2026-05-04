package runner

import (
	"context"
	"testing"
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
