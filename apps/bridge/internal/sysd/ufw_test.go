package sysd

import (
	"context"
	"strings"
	"testing"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/runner"
)

func TestUFWRuleAdd(t *testing.T) {
	fake := &runner.Fake{Stdout: []byte("Rule added")}
	u := &UFW{R: fake}
	out, err := u.Rule(context.Background(), "add", "udp", 7787, "squad-game")
	if err != nil {
		t.Fatalf("Rule: %v", err)
	}
	if !strings.Contains(out, "Rule added") {
		t.Fatalf("out=%q", out)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("calls=%d want 1", len(fake.Calls))
	}
	call := fake.Calls[0]
	if call.Cmd != "ufw" {
		t.Fatalf("cmd=%q want ufw", call.Cmd)
	}
	expected := []string{"allow", "7787/udp", "comment", "squad-game"}
	if len(call.Args) != len(expected) {
		t.Fatalf("args=%v want %v", call.Args, expected)
	}
	for i, want := range expected {
		if call.Args[i] != want {
			t.Fatalf("args[%d]=%q want %q", i, call.Args[i], want)
		}
	}
}

func TestUFWRuleRemove(t *testing.T) {
	fake := &runner.Fake{Stdout: []byte("Rule deleted")}
	u := &UFW{R: fake}
	out, err := u.Rule(context.Background(), "remove", "tcp", 21114, "")
	if err != nil {
		t.Fatalf("Rule: %v", err)
	}
	if !strings.Contains(out, "Rule deleted") {
		t.Fatalf("out=%q", out)
	}
	call := fake.Calls[0]
	expected := []string{"delete", "allow", "21114/tcp"}
	if len(call.Args) != len(expected) {
		t.Fatalf("args=%v want %v", call.Args, expected)
	}
}

func TestUFWRuleInvalidAction(t *testing.T) {
	fake := &runner.Fake{}
	u := &UFW{R: fake}
	_, err := u.Rule(context.Background(), "purge", "tcp", 7787, "")
	if err == nil {
		t.Fatal("expected error for invalid action")
	}
	if len(fake.Calls) != 0 {
		t.Fatal("should not call runner on invalid action")
	}
}

func TestUFWRuleInvalidProto(t *testing.T) {
	fake := &runner.Fake{}
	u := &UFW{R: fake}
	_, err := u.Rule(context.Background(), "add", "icmp", 7787, "")
	if err == nil {
		t.Fatal("expected error for invalid proto")
	}
}

func TestUFWRuleInvalidPort(t *testing.T) {
	fake := &runner.Fake{}
	u := &UFW{R: fake}
	_, err := u.Rule(context.Background(), "add", "udp", 22, "")
	if err == nil {
		t.Fatal("expected error for invalid port")
	}
}

func TestUFWRuleNonZeroExit(t *testing.T) {
	fake := &runner.Fake{Exit: 1, Stderr: []byte("permission denied")}
	u := &UFW{R: fake}
	_, err := u.Rule(context.Background(), "add", "tcp", 7787, "test")
	if err == nil {
		t.Fatal("expected error on non-zero exit")
	}
	if !strings.Contains(err.Error(), "ufw exit 1") {
		t.Fatalf("error=%v", err)
	}
}
