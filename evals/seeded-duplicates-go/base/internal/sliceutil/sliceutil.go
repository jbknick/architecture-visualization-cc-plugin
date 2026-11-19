// Package sliceutil holds small slice helpers.
package sliceutil

import "strings"

// Dedupe returns items without repeats, keeping the first spelling of each.
func Dedupe(items []string) []string {
	seen := make(map[string]bool, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		key := strings.ToLower(strings.TrimSpace(item))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, item)
	}
	return out
}

// Chunk splits values into consecutive groups of at most size items.
func Chunk(values []int, size int) [][]int {
	if size <= 0 {
		return nil
	}
	groups := make([][]int, 0, (len(values)+size-1)/size)
	for start := 0; start < len(values); start += size {
		end := start + size
		if end > len(values) {
			end = len(values)
		}
		groups = append(groups, values[start:end])
	}
	return groups
}
