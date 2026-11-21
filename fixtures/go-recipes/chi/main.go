package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Get("/ping", ping)
	r.Mount("/api", apiRouter())
	r.Group(func(r chi.Router) {
		r.Use(requireLogin)
		r.Get("/me", me)
	})
	r.Handle("/static/*", http.NotFoundHandler())
	http.ListenAndServe(":3000", r)
}

func ping(w http.ResponseWriter, r *http.Request) {}

func me(w http.ResponseWriter, r *http.Request) {}

func requireLogin(next http.Handler) http.Handler { return next }
