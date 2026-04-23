package validate

import "errors"

// ErrInvalidArgs is returned when an argument is structurally wrong
// (for example, an empty list where one is required).
var ErrInvalidArgs = errors.New("invalid arguments")
