// Package timeutil holds small time helpers.
package timeutil

import (
	"fmt"
	"time"
)

// FormatAgo renders how long ago something happened, such as "3 days ago".
func FormatAgo(elapsed time.Duration) string {
	if elapsed < 0 {
		elapsed = 0
	}
	units := []struct {
		name string
		size time.Duration
	}{
		{"day", 24 * time.Hour},
		{"hour", time.Hour},
		{"minute", time.Minute},
	}
	for _, u := range units {
		count := int(elapsed / u.size)
		if count < 1 {
			continue
		}
		plural := ""
		if count != 1 {
			plural = "s"
		}
		return fmt.Sprintf("%d %s%s ago", count, u.name, plural)
	}
	return "just now"
}

// DaysBetween counts the calendar days from one moment to another, in either order.
func DaysBetween(from, to time.Time) int {
	if to.Before(from) {
		from, to = to, from
	}
	start := time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, time.UTC)
	end := time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, time.UTC)
	days := 0
	for cursor := start; cursor.Before(end); cursor = cursor.AddDate(0, 0, 1) {
		days++
	}
	return days
}
