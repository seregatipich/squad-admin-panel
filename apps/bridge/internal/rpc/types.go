package rpc

import (
	"encoding/json"
)

// Request is the common envelope the panel sends us.
type Request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Response is the common envelope we send back.
// Exactly one of Result or Error is populated.
type Response struct {
	ID     string          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *ErrorObject    `json:"error,omitempty"`
}

// StreamFrame is produced by the streaming methods (container_logs_follow,
// file_read_stream, depot_update, docker_prune, backup_run, backup_restore).
// It is written as a standalone frame on the same socket between the
// request and the final Response. Consumers see the frames interleaved.
type StreamFrame struct {
	ID     string          `json:"id"`
	Stream string          `json:"stream"` // "stdout" | "stderr" | "event"
	Data   json.RawMessage `json:"data"`
}

// ErrorObject maps application-level errors (not transport).
type ErrorObject struct {
	Code    string `json:"code"` // forbidden | invalid_args | not_found | runtime_error | timeout | internal
	Message string `json:"message"`
}

// Well-known error codes.
const (
	CodeForbidden   = "forbidden"
	CodeInvalidArgs = "invalid_args"
	// CodeNotFound reports that a file a read targeted does not exist, so
	// callers can tell "absent" from a real I/O failure without parsing the
	// OS error text.
	CodeNotFound     = "not_found"
	CodeRuntimeError = "runtime_error"
	CodeTimeout      = "timeout"
	CodeInternal     = "internal"
)

// NewErrorResponse builds a failure envelope.
func NewErrorResponse(id, code, msg string) Response {
	return Response{
		ID: id,
		OK: false,
		Error: &ErrorObject{
			Code:    code,
			Message: msg,
		},
	}
}

// NewSuccessResponse builds a success envelope carrying the given JSON result.
func NewSuccessResponse(id string, result json.RawMessage) Response {
	return Response{
		ID:     id,
		OK:     true,
		Result: result,
	}
}
