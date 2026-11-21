-- name: ListPosts :many
SELECT id, title FROM posts
ORDER BY id;

-- name: PublishPost :exec
UPDATE posts SET published = TRUE WHERE id = $1;

-- name: ListAuthorPosts :many
SELECT p.id, p.title, u.name
FROM posts p
JOIN users u ON u.id = p.author_id;
