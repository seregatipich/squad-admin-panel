package rpc

import (
	"encoding/json"
	"testing"
)

func TestNewErrorResponse(t *testing.T) {
	resp := NewErrorResponse("req-42", CodeForbidden, "not allowed")
	if resp.ID != "req-42" {
		t.Fatalf("ID=%q want %q", resp.ID, "req-42")
	}
	if resp.OK {
		t.Fatal("error response must have OK=false")
	}
	if resp.Error == nil {
		t.Fatal("Error must be non-nil")
	}
	if resp.Error.Code != CodeForbidden {
		t.Fatalf("code=%q want %q", resp.Error.Code, CodeForbidden)
	}
	if resp.Error.Message != "not allowed" {
		t.Fatalf("message=%q want %q", resp.Error.Message, "not allowed")
	}
	if resp.Result != nil {
		t.Fatal("error response must have nil Result")
	}
}

func TestNewSuccessResponse(t *testing.T) {
	payload := json.RawMessage(`{"count":5}`)
	resp := NewSuccessResponse("req-7", payload)
	if resp.ID != "req-7" {
		t.Fatalf("ID=%q want %q", resp.ID, "req-7")
	}
	if !resp.OK {
		t.Fatal("success response must have OK=true")
	}
	if resp.Error != nil {
		t.Fatal("success response must have nil Error")
	}
	if string(resp.Result) != `{"count":5}` {
		t.Fatalf("Result=%q want %q", string(resp.Result), `{"count":5}`)
	}
}

func TestResponseJSONRoundTrip(t *testing.T) {
	resp := NewErrorResponse("id-1", CodeRuntimeError, "oops")
	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded Response
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.ID != resp.ID || decoded.OK != resp.OK {
		t.Fatal("roundtrip mismatch on ID/OK")
	}
	if decoded.Error.Code != CodeRuntimeError {
		t.Fatalf("roundtrip code=%q want %q", decoded.Error.Code, CodeRuntimeError)
	}
}

func TestStreamFrameJSON(t *testing.T) {
	sf := StreamFrame{
		ID:     "stream-1",
		Stream: "stdout",
		Data:   json.RawMessage(`"hello"`),
	}
	data, err := json.Marshal(sf)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded StreamFrame
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.ID != "stream-1" || decoded.Stream != "stdout" {
		t.Fatalf("roundtrip failed: %+v", decoded)
	}
}

func TestErrorCodes(t *testing.T) {
	codes := []string{CodeForbidden, CodeInvalidArgs, CodeRuntimeError, CodeTimeout, CodeInternal}
	seen := make(map[string]bool)
	for _, c := range codes {
		if c == "" {
			t.Fatal("error code must not be empty")
		}
		if seen[c] {
			t.Fatalf("duplicate code: %q", c)
		}
		seen[c] = true
	}
}

func TestRequestUnmarshal(t *testing.T) {
	raw := `{"id":"a","method":"ping","params":{"foo":1}}`
	var req Request
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if req.ID != "a" {
		t.Fatalf("ID=%q want %q", req.ID, "a")
	}
	if req.Method != "ping" {
		t.Fatalf("Method=%q want %q", req.Method, "ping")
	}
	if string(req.Params) != `{"foo":1}` {
		t.Fatalf("Params=%q", string(req.Params))
	}
}
