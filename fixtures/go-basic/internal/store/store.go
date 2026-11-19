// Package store keeps values in memory.
package store

import "sync"

// Reader is the read side of a Store.
type Reader interface {
	Get(key string) (string, bool)
}

// Store is a small concurrent key-value store.
type Store struct {
	mu    sync.Mutex
	items map[string]string
}

// New returns an empty Store.
func New() *Store {
	return &Store{items: map[string]string{}}
}

// Get returns the value stored under key.
func (s *Store) Get(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.items[key]
	return v, ok
}

// Put stores value under key.
func (s *Store) Put(key, value string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items[key] = value
}
