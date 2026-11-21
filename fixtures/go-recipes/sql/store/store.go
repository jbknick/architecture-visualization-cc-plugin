package store

import "database/sql"

// ListUsers reads users.
func ListUsers(db *sql.DB) (*sql.Rows, error) {
	return db.Query("SELECT id, name FROM users ORDER BY id")
}

// CreatePost writes posts.
func CreatePost(db *sql.DB, authorID int64, title string) error {
	_, err := db.Exec("INSERT INTO posts (author_id, title) VALUES ($1, $2)", authorID, title)
	return err
}

// PostsByUser reads posts and users, in a raw string over several lines.
func PostsByUser(db *sql.DB, id int64) (*sql.Rows, error) {
	return db.Query(`
		SELECT p.id, p.title
		FROM posts p
		JOIN users u ON u.id = p.author_id
		WHERE u.id = $1`, id)
}

// DeleteUser writes users, with the statement joined from two strings.
func DeleteUser(db *sql.DB, id int64) error {
	_, err := db.Exec("DELETE FROM "+usersTable+" WHERE id = $1", id)
	return err
}

const usersTable = "users"

// CountRows reads a table named by its caller: a run-time name, never guessed.
func CountRows(db *sql.DB, table string) (n int, err error) {
	err = db.QueryRow("SELECT count(*) FROM " + table).Scan(&n)
	return n, err
}
