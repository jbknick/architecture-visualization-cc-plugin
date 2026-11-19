package main

import (
	"fmt"

	"example.com/gobasic/internal/store"
	str "example.com/gobasic/internal/text"
)

func main() {
	s := store.New()
	s.Put("greeting", "Hello, World")
	v, ok := s.Get("greeting")
	if !ok {
		fmt.Println("missing")
		return
	}
	fmt.Println(str.Slugify(v))
}
