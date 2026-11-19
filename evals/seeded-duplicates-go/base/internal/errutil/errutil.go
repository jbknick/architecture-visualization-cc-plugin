// Package errutil holds small error helpers.
package errutil

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// FirstError returns the first real error of a batch and mentions how many were cancellations.
func FirstError(errs []error) error {
	var first error
	canceled := 0
	for _, err := range errs {
		if err == nil {
			continue
		}
		if errors.Is(err, context.Canceled) {
			canceled++
			continue
		}
		if first == nil {
			first = err
		}
	}
	if first != nil && canceled > 0 {
		return fmt.Errorf("%w (and %d canceled)", first, canceled)
	}
	return first
}

// WrapAll folds a batch of errors into one error whose text names each position under a prefix.
func WrapAll(prefix string, errs []error) error {
	var parts []string
	for i, err := range errs {
		if err == nil {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s[%d]: %v", prefix, i, err))
	}
	if len(parts) == 0 {
		return nil
	}
	sort.Strings(parts)
	return errors.New(strings.Join(parts, "; "))
}
