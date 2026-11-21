package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type UserAPI struct{}

// Routes returns the sub-router that main mounts under /api/users.
func (a *UserAPI) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/{id}", a.get)
	r.Post("/", a.create)
	return r
}

func (a *UserAPI) get(w http.ResponseWriter, r *http.Request) {}

func (a *UserAPI) create(w http.ResponseWriter, r *http.Request) {}
