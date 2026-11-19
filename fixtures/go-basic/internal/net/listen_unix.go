//go:build unix

package net

func listen() string {
	return "unix"
}
