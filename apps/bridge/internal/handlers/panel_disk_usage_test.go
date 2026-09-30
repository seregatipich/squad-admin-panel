package handlers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/rpc"
)

// ageDiskUsageCache moves the cached result's timestamp into the past so a
// test can step over the TTL or the force rate limit without sleeping.
func ageDiskUsageCache(by time.Duration) {
	panelDiskCacheMu.Lock()
	panelDiskCacheStored = panelDiskCacheStored.Add(-by)
	panelDiskCacheMu.Unlock()
}

func stubDiskDispatcher(t *testing.T, du func(ctx context.Context, path string) (int64, error)) *Dispatcher {
	t.Helper()
	resetPanelDiskUsageCache()
	t.Cleanup(resetPanelDiskUsageCache)
	return &Dispatcher{
		panelRoot: t.TempDir(),
		duFn:      du,
		statfsFn:  func(string, *syscall.Statfs_t) error { return nil },
		dockerDfFn: func(context.Context) ([]dockerVol, []dockerImg, int64, error) {
			return nil, nil, 0, nil
		},
	}
}

func diskUsageReq(force bool) *rpc.Request {
	params := []byte(`{}`)
	if force {
		params = []byte(`{"force":true}`)
	}
	return &rpc.Request{ID: "disk", Method: "panel_disk_usage", Params: params}
}

// Regression for #45 (findings #1353, #401): a slow or hung recomputation
// must not block callers that the cache can already answer. The old handler
// held panelDiskCacheMu for the whole du/docker run, so one hung `du` froze
// every later panel_disk_usage call, cached or not.
func TestPanelDiskUsage_CachedReadDoesNotBlockBehindRecompute(t *testing.T) {
	var block atomic.Bool
	release := make(chan struct{})
	entered := make(chan struct{}, 16)
	d := stubDiskDispatcher(t, func(ctx context.Context, string string) (int64, error) {
		if block.Load() {
			entered <- struct{}{}
			<-release
		}
		return 0, nil
	})
	defer close(release)
	if resp := d.Handle(context.Background(), diskUsageReq(false), func(rpc.StreamFrame) {}); !resp.OK {
		t.Fatalf("prime cache: %+v", resp.Error)
	}
	ageDiskUsageCache(panelDiskForceMinInterval + time.Second)

	block.Store(true)
	go d.Handle(context.Background(), diskUsageReq(true), func(rpc.StreamFrame) {})
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("forced recompute never started")
	}

	done := make(chan rpc.Response, 1)
	go func() { done <- d.Handle(context.Background(), diskUsageReq(false), func(rpc.StreamFrame) {}) }()
	select {
	case resp := <-done:
		if !resp.OK {
			t.Fatalf("cached read failed: %+v", resp.Error)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cached read blocked behind the in-flight recompute")
	}
}

// Concurrent forced refreshes share one walk instead of queueing a full
// du/docker pass per click, and a force right after a fresh computation is
// answered from the cache.
func TestPanelDiskUsage_ForceIsCoalescedAndRateLimited(t *testing.T) {
	var walks atomic.Int32
	gate := make(chan struct{})
	d := stubDiskDispatcher(t, func(ctx context.Context, path string) (int64, error) {
		if filepath.Base(path) == "configs" {
			walks.Add(1)
			<-gate
		}
		return 0, nil
	})

	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if resp := d.Handle(context.Background(), diskUsageReq(true), func(rpc.StreamFrame) {}); !resp.OK {
				t.Errorf("force: %+v", resp.Error)
			}
		}()
	}
	time.Sleep(200 * time.Millisecond)
	close(gate)
	wg.Wait()
	if got := walks.Load(); got != 1 {
		t.Fatalf("concurrent forced refreshes ran %d walks, want 1", got)
	}

	if resp := d.Handle(context.Background(), diskUsageReq(true), func(rpc.StreamFrame) {}); !resp.OK {
		t.Fatalf("force after fresh compute: %+v", resp.Error)
	}
	if got := walks.Load(); got != 1 {
		t.Fatalf("force within %s of the last computation re-walked the disk (walks=%d)", panelDiskForceMinInterval, got)
	}
}

// Every probe receives a bounded context so a hung du or docker daemon
// cannot pin a bridge goroutine and child process forever.
func TestPanelDiskUsage_ProbesGetDeadline(t *testing.T) {
	var sawNoDeadline atomic.Bool
	d := stubDiskDispatcher(t, func(ctx context.Context, string string) (int64, error) {
		if _, ok := ctx.Deadline(); !ok {
			sawNoDeadline.Store(true)
		}
		return 0, nil
	})
	var dockerDeadline atomic.Bool
	d.dockerDfFn = func(ctx context.Context) ([]dockerVol, []dockerImg, int64, error) {
		_, ok := ctx.Deadline()
		dockerDeadline.Store(ok)
		return nil, nil, 0, nil
	}
	if resp := d.Handle(context.Background(), diskUsageReq(false), func(rpc.StreamFrame) {}); !resp.OK {
		t.Fatalf("panel_disk_usage: %+v", resp.Error)
	}
	if sawNoDeadline.Load() || !dockerDeadline.Load() {
		t.Fatal("disk probes ran without a deadline")
	}
}

// The saved tree is walked once: saved_total_bytes is the sum of the
// per-server walks, not a second `du` over the whole saved root.
func TestPanelDiskUsage_WalksSavedTreeOnce(t *testing.T) {
	var paths []string
	var mu sync.Mutex
	d := stubDiskDispatcher(t, func(ctx context.Context, path string) (int64, error) {
		mu.Lock()
		paths = append(paths, path)
		mu.Unlock()
		return 100, nil
	})
	for _, uuid := range []string{"a", "b"} {
		if err := os.MkdirAll(filepath.Join(d.panelRoot, "saved", uuid), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	resp := d.Handle(context.Background(), diskUsageReq(false), func(rpc.StreamFrame) {})
	if !resp.OK {
		t.Fatalf("panel_disk_usage: %+v", resp.Error)
	}
	savedRoot := filepath.Join(d.panelRoot, "saved")
	for _, p := range paths {
		if p == savedRoot {
			t.Fatalf("saved root walked in addition to every server dir: %v", paths)
		}
	}
	var got panelDiskUsageResult
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatal(err)
	}
	if got.SavedTotalBytes != 200 {
		t.Fatalf("saved_total_bytes = %d, want the per-server sum 200", got.SavedTotalBytes)
	}
}

// Only docker's "No such volume" is a benign miss; any other inspect
// failure (daemon down, permission) must surface instead of being reported
// as an absent volume.
func TestIsNoSuchVolume(t *testing.T) {
	if !isNoSuchVolume([]byte("Error response from daemon: get squad-depot: no such volume\n")) {
		t.Fatal("docker's no-such-volume stderr must be recognised")
	}
	if isNoSuchVolume([]byte("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n")) {
		t.Fatal("a daemon connection failure must not be treated as a missing volume")
	}
}
