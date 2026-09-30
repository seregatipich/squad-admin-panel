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
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Runner represents a strategy for executing external commands.
type Runner interface {
	// Run blocks until the command exits. stdout/stderr are captured. A
	// non-zero exit is reported through exit with err == nil; err is set when
	// the command could not run or ctx was cancelled (then err wraps
	// ctx.Err(), so callers can tell a timeout from a failing command).
	Run(ctx context.Context, cmd string, args []string, env []string) (stdout, stderr []byte, exit int, err error)

	// Stream writes stdout/stderr as they arrive to the provided sinks.
	// Both callbacks may be nil. Returns the exit code when the process ends,
	// with the same error contract as Run.
	Stream(ctx context.Context, cmd string, args []string, env []string, onStdout, onStderr func([]byte)) (int, error)
}

// Real is a real Runner backed by os/exec.
type Real struct{}

// streamWaitDelay bounds how long a cancelled command may keep its output
// pipes open after the process group was killed, e.g. through a descendant
// that escaped the group with setsid. After it the pipes are force-closed.
// Tests shorten it.
var streamWaitDelay = 5 * time.Second

// command builds an exec.Cmd that runs in its own process group. On ctx
// cancellation the whole group is SIGKILLed, not just the direct child, so a
// shell script's descendants (restore.sh -> docker compose / docker run) die
// with it instead of keeping the pipes open and the work running orphaned.
// WaitDelay force-closes the pipes of anything that escaped the group.
func command(ctx context.Context, cmd string, args []string, env []string) *exec.Cmd {
	c := exec.CommandContext(ctx, cmd, args...)
	if len(env) > 0 {
		c.Env = env
	}
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	c.Cancel = func() error {
		return unix.Kill(-c.Process.Pid, unix.SIGKILL)
	}
	c.WaitDelay = streamWaitDelay
	return c
}

// exitResult converts the error of a finished command into Runner's
// (exit, err) contract. Cancellation takes precedence: exec reports a killed
// process as *exec.ExitError ("signal: killed"), which must not be mistaken
// for an ordinary non-zero exit.
func exitResult(ctx context.Context, err error) (int, error) {
	if err == nil {
		return 0, nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return -1, ctxErr
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	return -1, err
}

// Run implements Runner.
func (Real) Run(ctx context.Context, cmd string, args []string, env []string) ([]byte, []byte, int, error) {
	c := command(ctx, cmd, args, env)
	var so, se bytes.Buffer
	c.Stdout, c.Stderr = &so, &se
	exitCode, err := exitResult(ctx, c.Run())
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
	c := command(ctx, cmd, args, env)
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
	pumped := make(chan struct{})
	go func() {
		wg.Wait()
		close(pumped)
	}()
	select {
	case <-pumped:
	case <-ctx.Done():
		// exec's Cancel has killed the process group. Give the pumps
		// streamWaitDelay to drain, then close the read ends so a
		// descendant that escaped the group cannot block us.
		select {
		case <-pumped:
		case <-time.After(streamWaitDelay):
			_ = stdout.Close()
			_ = stderr.Close()
			<-pumped
		}
	}

	return exitResult(ctx, c.Wait())
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
