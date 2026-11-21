package store

// Orm is a stand-in for a mapper library: tables are declared with Define and rows are saved with Create and loaded
// with Find. The recipe tells Gantry which method does what; the engine knows none of these names.
type Orm struct{}

func (o *Orm) Define(model any) {}

func (o *Orm) Create(row any) {}

func (o *Orm) Find(rows any) {}

type Audit struct {
	Action string
}

func Migrate(o *Orm) {
	o.Define(&Audit{})
}

// LogAudit writes the Audit table through a typed value.
func LogAudit(o *Orm, action string) {
	a := Audit{Action: action}
	o.Create(&a)
}

// RecentAudits reads the Audit table through a slice of the model.
func RecentAudits(o *Orm) []Audit {
	var rows []Audit
	o.Find(&rows)
	return rows
}
