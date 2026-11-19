// Package strutil holds small string helpers.
package strutil

import (
	"strings"
	"unicode"
)

// Slugify lower-cases s and joins its words with single dashes.
func Slugify(s string) string {
	var b strings.Builder
	lastDash := true
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r):
			b.WriteRune(r)
			lastDash = false
		case !lastDash:
			b.WriteByte('-')
			lastDash = true
		}
	}
	out := b.String()
	return strings.TrimSuffix(out, "-")
}

// TitleCase upper-cases the first letter of every word and lower-cases the rest.
func TitleCase(s string) string {
	words := strings.Fields(strings.ToLower(s))
	for i, w := range words {
		runes := []rune(w)
		if len(runes) == 0 {
			continue
		}
		runes[0] = unicode.ToUpper(runes[0])
		words[i] = string(runes)
	}
	joined := strings.Join(words, " ")
	return strings.TrimSpace(joined)
}
