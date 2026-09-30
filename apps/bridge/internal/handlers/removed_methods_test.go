package handlers

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/rpc"
)

// Regression for #45 (findings #1342, #400): process_info, file_read_tail and
// file_write had no production caller and only widened the root bridge's
// attack surface (process_info read /proc/<pid>/cmdline of any host PID).
// They must be rejected as unknown methods.
func TestRemovedMethodsAreUnknown(t *testing.T) {
	params, _ := json.Marshal(map[string]any{"pid": 1, "path": "/var/lib/squad-panel/x", "content": "x"})
	for _, method := range []string{"process_info", "file_read_tail", "file_write"} {
		resp := (&Dispatcher{}).Handle(context.Background(), &rpc.Request{ID: "r", Method: method, Params: params}, func(rpc.StreamFrame) {})
		if resp.Error == nil || resp.Error.Code != rpc.CodeInvalidArgs || !strings.Contains(resp.Error.Message, "unknown method") {
			t.Errorf("%s: want unknown-method error, got %+v", method, resp)
		}
	}
}
