package main

import "net/http"

type usersHandler struct{}

func registerUsers(mux *http.ServeMux) {
	h := &usersHandler{}
	mux.HandleFunc("GET /users/{id}", h.get)
	mux.HandleFunc("POST /users", h.create)
	mux.Handle("DELETE /users/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
}

// registerLegacy is called nowhere, so its routes are registered at the paths written here.
func registerLegacy(mux *http.ServeMux) {
	mux.HandleFunc("GET /legacy", health)
}

func (h *usersHandler) get(w http.ResponseWriter, r *http.Request) {}

func (h *usersHandler) create(w http.ResponseWriter, r *http.Request) {}
