package users

import "github.com/gin-gonic/gin"

// Register adds the user routes to the group that main passes in.
func Register(g *gin.RouterGroup) {
	g.GET("", list)
	g.POST("/", create)
	g.GET("/:id", get)
	g.DELETE("/:id", remove)
}

func list(c *gin.Context) {}

func create(c *gin.Context) {}

func get(c *gin.Context) {}

func remove(c *gin.Context) {}
