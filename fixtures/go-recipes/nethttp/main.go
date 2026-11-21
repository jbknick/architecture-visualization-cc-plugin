package main

import "net/http"

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", health)
	mux.HandleFunc("/", index)
	mux.HandleFunc("shop.example.com/", shopHost)
	registerUsers(mux)
	http.ListenAndServe(":8080", mux)
}

func health(w http.ResponseWriter, r *http.Request) {}

func index(w http.ResponseWriter, r *http.Request) {}

func shopHost(w http.ResponseWriter, r *http.Request) {}
