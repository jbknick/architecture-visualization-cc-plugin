// Package maputil holds small map helpers.
package maputil

import (
	"fmt"
	"sort"
)

// MergeCounts adds the counts of two maps and drops the keys that end up at zero.
func MergeCounts(a, b map[string]int) map[string]int {
	merged := make(map[string]int, len(a)+len(b))
	for key, n := range a {
		merged[key] += n
	}
	for key, n := range b {
		merged[key] += n
	}
	for key, n := range merged {
		if n == 0 {
			delete(merged, key)
		}
	}
	return merged
}

// InvertMap swaps keys and values and fails when two keys share a value.
func InvertMap(m map[string]string) (map[string]string, error) {
	inverted := make(map[string]string, len(m))
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := m[key]
		if prev, ok := inverted[value]; ok {
			return nil, fmt.Errorf("value %q is used by both %q and %q", value, prev, key)
		}
		inverted[value] = key
	}
	return inverted, nil
}
