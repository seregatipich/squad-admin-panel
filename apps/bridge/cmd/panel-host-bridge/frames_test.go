package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/seregatipich/squad-admin-panel/apps/bridge/internal/rpc"
)

// Regression for #74 (findings #385/#413): a Response whose encoding exceeds
// rpc.MaxFrame (e.g. a file_read of a ~10 MiB file full of JSON-escaped
// bytes) used to be dropped silently, leaving the caller waiting for its RPC
// timeout. It must be replaced by a compact error Response for the same id.
func TestEncodeResponse_OversizedResultBecomesErrorResponse(t *testing.T) {
	huge, _ := json.Marshal(map[string]string{"content": strings.Repeat("<", rpc.MaxFrame/6+1)})
	payload, err := encodeResponse(rpc.NewSuccessResponse("req-big", huge))
	if err == nil {
		t.Fatal("encodeResponse must report why the original response was not sent")
	}
	if len(payload) > rpc.MaxFrame {
		t.Fatalf("fallback payload is %d bytes, over MaxFrame", len(payload))
	}
	var resp rpc.Response
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("fallback payload is not a Response: %v", err)
	}
	if resp.ID != "req-big" || resp.OK || resp.Error == nil || resp.Error.Code != rpc.CodeRuntimeError {
		t.Fatalf("fallback = %+v, want runtime_error for req-big", resp)
	}
}

func TestEncodeResponse_UnmarshalableResultBecomesInternalError(t *testing.T) {
	payload, err := encodeResponse(rpc.NewSuccessResponse("req-bad", json.RawMessage(`{not json`)))
	if err == nil {
		t.Fatal("encodeResponse must surface the marshal error")
	}
	var resp rpc.Response
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("fallback payload is not a Response: %v", err)
	}
	if resp.ID != "req-bad" || resp.Error == nil || resp.Error.Code != rpc.CodeInternal {
		t.Fatalf("fallback = %+v, want internal error for req-bad", resp)
	}
}

func TestEncodeResponse_NormalResponseUnchanged(t *testing.T) {
	payload, err := encodeResponse(rpc.NewSuccessResponse("req-ok", json.RawMessage(`{"pong":true}`)))
	if err != nil {
		t.Fatalf("encodeResponse: %v", err)
	}
	if string(payload) != `{"id":"req-ok","ok":true,"result":{"pong":true}}` {
		t.Fatalf("payload=%s", payload)
	}
}
