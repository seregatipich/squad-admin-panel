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

// StreamFrame is produced by streaming methods (steamcmd_run, journalctl_follow).
// It is written as a standalone frame on the same socket between the
// request and the final Response. Consumers see the frames interleaved.
type StreamFrame struct {
	ID     string          `json:"id"`
	Stream string          `json:"stream"` // "stdout" | "stderr" | "event"
	Data   json.RawMessage `json:"data"`
}

// ErrorObject maps application-level errors (not transport).
type ErrorObject struct {
	Code    string          `json:"code"`    // forbidden | invalid_args | runtime_error | timeout | internal
	Message string          `json:"message"`
	Detail  json.RawMessage `json:"detail,omitempty"`
}

// Well-known error codes.
const (
	CodeForbidden    = "forbidden"
	CodeInvalidArgs  = "invalid_args"
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
