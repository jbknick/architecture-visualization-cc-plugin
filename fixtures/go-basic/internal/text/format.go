package text

// Width limits for formatted output.
const (
	MinWidth, MaxWidth = 8, 80
	tabWidth           = 4
)

var defaultSeparator = ", "

// Label is another name for string.
type Label = string

// Kind says how a value is printed.
type Kind int

func (k Kind) String() string {
	if k == 0 {
		return "plain"
	}
	return "fancy"
}
