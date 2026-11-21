package main

import (
	"github.com/gin-gonic/gin"

	"example.com/gorecipes/gin/users"
)

func main() {
	r := gin.Default()
	v1 := r.Group("/api")
	users.Register(v1.Group("/users"))
	v1.Use(requireToken)
	v1.GET("/me", me)
	r.GET("/ping", func(c *gin.Context) {
		c.JSON(200, gin.H{"ok": true})
	})
	r.Run()
}

func me(c *gin.Context) {}

func requireToken(c *gin.Context) {}
