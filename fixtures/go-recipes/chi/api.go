package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// apiRouter is mounted at /api by main; the sub-routers below add their own prefixes.
func apiRouter() chi.Router {
	r := chi.NewRouter()
	r.Route("/items", func(r chi.Router) {
		r.Get("/", listItems)
		r.Post("/", createItem)
		r.Route("/{itemID}", func(r chi.Router) {
			r.Get("/", getItem)
		})
	})
	users := &UserAPI{}
	r.Mount("/users", users.Routes())
	return r
}

func listItems(w http.ResponseWriter, r *http.Request) {}

func createItem(w http.ResponseWriter, r *http.Request) {}

func getItem(w http.ResponseWriter, r *http.Request) {}
