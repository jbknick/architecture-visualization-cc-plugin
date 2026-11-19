// Package app wires the store and the text helpers together.
package app

import (
	"example.com/gobasic/internal/store"
	"example.com/gobasic/internal/text"
)

// Deps are the collaborators of an App.
type Deps struct {
	Store *store.Store
}

// App is a small application object.
type App struct {
	deps Deps
}

// New builds an App around a fresh Store.
func New() *App {
	return &App{deps: Deps{Store: store.New()}}
}

// Run stores a slug and reads it back through a field chain.
func (a *App) Run(title string) string {
	a.deps.Store.Put("slug", text.Slugify(title))
	v, _ := a.deps.Store.Get("slug")
	return clean(v)
}

func clean(s string) string {
	return text.Slugify(s)
}
