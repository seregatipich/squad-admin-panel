package handlers

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/rpc"
	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/runner"
)

// Regression for #74 (findings #395/#404/#1245): file_atomic_write applied the
// caller's mode verbatim as root. Unsafe modes must be refused as a policy
// violation before anything touches the filesystem.
func TestFileAtomicWrite_RejectsUnsafeMode(t *testing.T) {
	d := &Dispatcher{}
	path := "/var/lib/squad-panel/configs/00000000-0000-4000-8000-00000000abcd/ServerConfig/Admins.cfg"
	for _, mode := range []uint32{0o666, 0o777, 0o4644, 1<<23 | 0o644} {
		params, _ := json.Marshal(map[string]any{"path": path, "content": "x", "mode": mode})
		resp := d.Handle(context.Background(), &rpc.Request{ID: "w", Method: "file_atomic_write", Params: params}, func(rpc.StreamFrame) {})
		if resp.OK || resp.Error == nil || resp.Error.Code != rpc.CodeForbidden {
			t.Errorf("mode %#o: want forbidden, got %+v", mode, resp)
		}
	}
}

// Regression for #74 (finding #405): the error code was chosen by searching
// err.Error() for "forbidden", so raw docker/registry stderr such as
// "403 Forbidden" turned a genuine runtime failure into a policy violation.
func TestDockerStderrMentioningForbiddenStaysRuntimeError(t *testing.T) {
	fake := &runner.Fake{Exit: 1, Stderr: []byte("Error response from daemon: pull access denied: 403 forbidden")}
	d := &Dispatcher{Docker: runner.NewDocker(fake)}
	params, _ := json.Marshal(map[string]any{"name": "squad-019dbaa5-1234-7abc-8def-0123456789ab"})
	resp := d.Handle(context.Background(), &rpc.Request{ID: "s", Method: "container_start", Params: params}, func(rpc.StreamFrame) {})
	if resp.OK || resp.Error == nil || resp.Error.Code != rpc.CodeRuntimeError {
		t.Fatalf("want runtime_error, got %+v", resp)
	}
}

// Regression for #74 (finding #402): docker renders sizes with go-units
// HumanSize, which is decimal (kB=1e3, MB=1e6, GB=1e9, TB=1e12); parsing them
// with binary multipliers overstated reclaimed_bytes and image sizes by up to
// ~10%.
func TestParseHumanSize_UsesDockerDecimalUnits(t *testing.T) {
	cases := map[string]int64{
		"0B":      0,
		"512B":    512,
		"1.5kB":   1500,
		"250MB":   250_000_000,
		"146.9GB": 146_900_000_000,
		"2TB":     2_000_000_000_000,
		"1234":    1234,
	}
	for in, want := range cases {
		got, err := parseHumanSize(in)
		if err != nil || got != want {
			t.Errorf("parseHumanSize(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	if got := parseReclaimed("Deleted Images:\nTotal reclaimed space: 1.2GB\n"); got != 1_200_000_000 {
		t.Errorf("parseReclaimed = %d, want 1200000000", got)
	}
}

// Regression for #74 (finding #1354): hostMetrics lazily assigned
// d.MetricsCache without synchronisation, a data race when two host_metrics
// calls hit a Dispatcher that was built without a cache (run with -race).
func TestHostMetrics_NilCacheIsRaceFree(t *testing.T) {
	d := &Dispatcher{DiskRoot: t.TempDir()}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp := d.Handle(context.Background(), &rpc.Request{ID: "m", Method: "host_metrics"}, func(rpc.StreamFrame) {})
			if !resp.OK {
				t.Errorf("host_metrics failed: %+v", resp.Error)
			}
		}()
	}
	wg.Wait()
}
