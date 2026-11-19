package store

import "testing"

func TestPutGet(t *testing.T) {
	s := New()
	s.Put("a", "b")
	if v, ok := s.Get("a"); !ok || v != "b" {
		t.Fatalf("got %q, %v", v, ok)
	}
}
