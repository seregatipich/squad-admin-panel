// Package runner abstracts external command execution so the privileged
// methods remain unit-testable. The real implementation shells out;
// tests use the Fake to capture arguments and return canned output.
package runner

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"sync"
)

// Runner represents a strategy for executing external commands.
type Runner interface {
	// Run blocks until the command exits. stdout/stderr are captured.
	Run(ctx context.Context, cmd string, args []string, env []string) (stdout, stderr []byte, exit int, err error)

	// Stream writes stdout/stderr as they arrive to the provided sinks.
	// Both callbacks may be nil. Returns the exit code when the process ends.
	Stream(ctx context.Context, cmd string, args []string, env []string, onStdout, onStderr func([]byte)) (int, error)
}

// Real is a real Runner backed by os/exec.
type Real struct{}

// Run implements Runner.
func (Real) Run(ctx context.Context, cmd string, args []string, env []string) ([]byte, []byte, int, error) {
	c := exec.CommandContext(ctx, cmd, args...)
	if len(env) > 0 {
		c.Env = env
	}
	var so, se bytes.Buffer
	c.Stdout, c.Stderr = &so, &se
	err := c.Run()
	exitCode := 0
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			exitCode = ee.ExitCode()
			err = nil
		}
	}
	return so.Bytes(), se.Bytes(), exitCode, err
}

// Stream implements Runner.
func (Real) Stream(
	ctx context.Context,
	cmd string,
	args []string,
	env []string,
	onStdout func([]byte),
	onStderr func([]byte),
) (int, error) {
	c := exec.CommandContext(ctx, cmd, args...)
	if len(env) > 0 {
		c.Env = env
	}
	stdout, err := c.StdoutPipe()
	if err != nil {
		return 0, err
	}
	stderr, err := c.StderrPipe()
	if err != nil {
		return 0, err
	}
	if err := c.Start(); err != nil {
		return 0, err
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go pumpPipe(&wg, stdout, onStdout)
	go pumpPipe(&wg, stderr, onStderr)
	wg.Wait()

	err = c.Wait()
	exitCode := 0
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			exitCode = ee.ExitCode()
			err = nil
		}
	}
	return exitCode, err
}

func pumpPipe(wg *sync.WaitGroup, pipe io.ReadCloser, sink func([]byte)) {
	defer wg.Done()
	defer func() { _ = pipe.Close() }()
	if sink == nil {
		_, _ = io.Copy(io.Discard, pipe)
		return
	}
	buf := make([]byte, 8192)
	for {
		n, err := pipe.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			sink(chunk)
		}
		if err != nil {
			return
		}
	}
}

// FakeCall records a captured Run/Stream invocation for tests.
type FakeCall struct {
	Cmd  string
	Args []string
	Env  []string
}

// Fake is an in-memory Runner used by tests.
type Fake struct {
	mu     sync.Mutex
	Calls  []FakeCall
	Stdout []byte
	Stderr []byte
	Exit   int
	Err    error
	OnRun  func(FakeCall)
}

// Run implements Runner.
func (f *Fake) Run(_ context.Context, cmd string, args []string, env []string) ([]byte, []byte, int, error) {
	call := FakeCall{Cmd: cmd, Args: append([]string(nil), args...), Env: append([]string(nil), env...)}
	f.mu.Lock()
	f.Calls = append(f.Calls, call)
	f.mu.Unlock()
	if f.OnRun != nil {
		f.OnRun(call)
	}
	return f.Stdout, f.Stderr, f.Exit, f.Err
}

// Stream implements Runner.
func (f *Fake) Stream(_ context.Context, cmd string, args []string, env []string, onStdout, onStderr func([]byte)) (int, error) {
	call := FakeCall{Cmd: cmd, Args: append([]string(nil), args...), Env: append([]string(nil), env...)}
	f.mu.Lock()
	f.Calls = append(f.Calls, call)
	f.mu.Unlock()
	if onStdout != nil && len(f.Stdout) > 0 {
		onStdout(f.Stdout)
	}
	if onStderr != nil && len(f.Stderr) > 0 {
		onStderr(f.Stderr)
	}
	return f.Exit, f.Err
}
