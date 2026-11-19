package text

import "strings"

// Slugify lower-cases s and joins its words with dashes.
func Slugify(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return trimDashes(b.String())
}

func trimDashes(s string) string {
	return strings.Trim(s, "-")
}
