// Ground truth for the v2-go spikes: top-level symbols (go/parser, every non-test .go file, all build tags) and
// type-checked call sites (go/packages + types.Info, files in the default build for this GOOS/GOARCH).
// Usage: go run . <repo-root> > truth.json
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

type Symbol struct {
	File     string `json:"file"`
	Name     string `json:"name"`
	Receiver string `json:"receiver,omitempty"`
	Kind     string `json:"kind"`
	Line     int    `json:"line"`
	Exported bool   `json:"exported"`
}

type Call struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Name   string `json:"name"`
	Caller string `json:"caller"`
	Kind   string `json:"kind"`
	Callee string `json:"callee,omitempty"`
	InRepo bool   `json:"inRepo"`
}

type Out struct {
	Module      string   `json:"module"`
	Symbols     []Symbol `json:"symbols"`
	Calls       []Call   `json:"calls"`
	CallFiles   []string `json:"callFiles"`
	Generated   []string `json:"generated"`
	TestFiles   int      `json:"testFiles"`
	VendorFiles int      `json:"vendorFiles"`
	ParseErrors int      `json:"parseErrors"`
	LoadErrors  int      `json:"loadErrors"`
	// In-repo interface (pkg.Name) -> in-repo concrete named types (pkg.Name) whose value or pointer implements it.
	Implementers map[string][]string `json:"implementers"`
}

var genRe = regexp.MustCompile(`(?m)^// Code generated .* DO NOT EDIT\.$`)

func baseTypeName(e ast.Expr) string {
	for {
		switch t := e.(type) {
		case *ast.StarExpr:
			e = t.X
		case *ast.IndexExpr:
			e = t.X
		case *ast.IndexListExpr:
			e = t.X
		case *ast.ParenExpr:
			e = t.X
		case *ast.Ident:
			return t.Name
		default:
			return "?"
		}
	}
}

func main() {
	root, _ := filepath.Abs(os.Args[1])
	out := Out{}
	modBytes, _ := os.ReadFile(filepath.Join(root, "go.mod"))
	for _, l := range strings.Split(string(modBytes), "\n") {
		if strings.HasPrefix(l, "module ") {
			out.Module = strings.TrimSpace(strings.TrimPrefix(l, "module "))
		}
	}
	fset := token.NewFileSet()
	// Symbols from every non-test file, regardless of build tags.
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		if d.IsDir() {
			if d.Name() == "vendor" {
				n := 0
				_ = filepath.WalkDir(p, func(q string, e fs.DirEntry, _ error) error {
					if e != nil && !e.IsDir() && strings.HasSuffix(q, ".go") {
						n++
					}
					return nil
				})
				out.VendorFiles += n
				return filepath.SkipDir
			}
			if rel != "." && (strings.HasPrefix(d.Name(), ".") || d.Name() == "testdata") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") {
			return nil
		}
		if strings.HasSuffix(p, "_test.go") {
			out.TestFiles++
			return nil
		}
		src, _ := os.ReadFile(p)
		if genRe.Match(src) {
			out.Generated = append(out.Generated, rel)
		}
		f, perr := parser.ParseFile(fset, p, src, parser.SkipObjectResolution)
		if perr != nil {
			out.ParseErrors++
		}
		if f == nil {
			return nil
		}
		for _, decl := range f.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				s := Symbol{File: rel, Name: d.Name.Name, Kind: "function", Line: fset.Position(d.Pos()).Line, Exported: ast.IsExported(d.Name.Name)}
				if d.Recv != nil && len(d.Recv.List) > 0 {
					s.Kind = "method"
					s.Receiver = baseTypeName(d.Recv.List[0].Type)
				}
				out.Symbols = append(out.Symbols, s)
			case *ast.GenDecl:
				for _, spec := range d.Specs {
					switch sp := spec.(type) {
					case *ast.TypeSpec:
						k := "type"
						switch sp.Type.(type) {
						case *ast.StructType:
							k = "class"
						case *ast.InterfaceType:
							k = "interface"
						}
						out.Symbols = append(out.Symbols, Symbol{File: rel, Name: sp.Name.Name, Kind: k, Line: fset.Position(sp.Pos()).Line, Exported: ast.IsExported(sp.Name.Name)})
					case *ast.ValueSpec:
						k := "var"
						if d.Tok == token.CONST {
							k = "const"
						}
						for _, n := range sp.Names {
							out.Symbols = append(out.Symbols, Symbol{File: rel, Name: n.Name, Kind: k, Line: fset.Position(n.Pos()).Line, Exported: ast.IsExported(n.Name)})
						}
					}
				}
			}
		}
		return nil
	})

	// Calls from type-checked packages.
	cfg := &packages.Config{Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes | packages.NeedTypesInfo | packages.NeedImports | packages.NeedDeps, Dir: root, Tests: false, Fset: fset}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	inRepo := func(p *types.Package) bool {
		return p != nil && (p.Path() == out.Module || strings.HasPrefix(p.Path(), out.Module+"/"))
	}
	funcKey := func(fn *types.Func) string {
		fn = fn.Origin()
		sig, _ := fn.Type().(*types.Signature)
		pkg := ""
		if fn.Pkg() != nil {
			pkg = fn.Pkg().Path()
		}
		if sig != nil && sig.Recv() != nil {
			t := sig.Recv().Type()
			if p, ok := t.(*types.Pointer); ok {
				t = p.Elem()
			}
			name := "?"
			switch n := t.(type) {
			case *types.Named:
				name = n.Origin().Obj().Name()
			case *types.Alias:
				name = n.Obj().Name()
			case *types.Interface:
				name = "?iface"
			}
			return pkg + "." + name + "." + fn.Name()
		}
		return pkg + "." + fn.Name()
	}
	seen := map[string]bool{}
	for _, pkg := range pkgs {
		out.LoadErrors += len(pkg.Errors)
		info := pkg.TypesInfo
		if info == nil {
			continue
		}
		for _, f := range pkg.Syntax {
			fname := fset.Position(f.Pos()).Filename
			if fname == "" {
				fname = pkg.Fset.Position(f.Pos()).Filename
			}
			rel, _ := filepath.Rel(root, fname)
			if seen[rel] {
				continue
			}
			seen[rel] = true
			out.CallFiles = append(out.CallFiles, rel)
			for _, decl := range f.Decls {
				fd, ok := decl.(*ast.FuncDecl)
				if !ok || fd.Body == nil {
					continue
				}
				caller := fd.Name.Name
				if fd.Recv != nil && len(fd.Recv.List) > 0 {
					caller = baseTypeName(fd.Recv.List[0].Type) + "." + caller
				}
				ast.Inspect(fd.Body, func(n ast.Node) bool {
					ce, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					fun := ce.Fun
					for {
						switch t := fun.(type) {
						case *ast.ParenExpr:
							fun = t.X
							continue
						case *ast.IndexExpr:
							fun = t.X
							continue
						case *ast.IndexListExpr:
							fun = t.X
							continue
						}
						break
					}
					c := Call{File: rel, Caller: caller}
					var nameId *ast.Ident
					switch t := fun.(type) {
					case *ast.Ident:
						nameId = t
						switch o := info.Uses[t].(type) {
						case *types.Builtin:
							c.Kind = "builtin"
						case *types.TypeName:
							c.Kind = "conversion"
						case *types.Func:
							c.Callee = funcKey(o)
							c.InRepo = inRepo(o.Pkg())
							if o.Pkg() == pkg.Types {
								c.Kind = "same-package"
							} else {
								c.Kind = "dot-import"
							}
						case *types.Var:
							c.Kind = "func-value"
						default:
							c.Kind = "other"
						}
					case *ast.SelectorExpr:
						nameId = t.Sel
						if sel, ok := info.Selections[t]; ok {
							switch sel.Kind() {
							case types.MethodVal, types.MethodExpr:
								fn := sel.Obj().(*types.Func)
								c.Callee = funcKey(fn)
								c.InRepo = inRepo(fn.Pkg())
								recv := sel.Recv()
								if types.IsInterface(recv) {
									c.Kind = "interface-method"
									// Key interface methods by the interface's named type, not the declaring embedded one.
									if p, ok := recv.(*types.Pointer); ok {
										recv = p.Elem()
									}
									if nt, ok := recv.(*types.Named); ok {
										c.Callee = funcKey(fn)
										if nt.Obj().Pkg() != nil {
											c.Callee = nt.Obj().Pkg().Path() + "." + nt.Origin().Obj().Name() + "." + fn.Name()
											c.InRepo = inRepo(nt.Obj().Pkg())
										}
									} else {
										c.Callee = ""
										c.Kind = "interface-method-unnamed"
									}
								} else {
									c.Kind = "method"
									if len(sel.Index()) > 1 {
										c.Kind = "method-promoted"
									}
								}
							case types.FieldVal:
								c.Kind = "func-field"
							}
						} else {
							switch o := info.Uses[t.Sel].(type) {
							case *types.Func:
								c.Kind = "pkg-qualified"
								c.Callee = funcKey(o)
								c.InRepo = inRepo(o.Pkg())
							case *types.TypeName:
								c.Kind = "conversion"
							case *types.Var:
								c.Kind = "func-value"
							default:
								c.Kind = "other"
							}
						}
					default:
						c.Kind = "other"
					}
					if nameId != nil {
						c.Name = nameId.Name
						c.Line = pkg.Fset.Position(nameId.Pos()).Line
					} else {
						c.Line = pkg.Fset.Position(ce.Pos()).Line
					}
					out.Calls = append(out.Calls, c)
					return true
				})
			}
		}
	}
	// Interface satisfaction among in-repo named types (what the plan says syntax cannot compute).
	var ifaces, concretes []*types.TypeName
	for _, pkg := range pkgs {
		if pkg.Types == nil || !inRepo(pkg.Types) {
			continue
		}
		sc := pkg.Types.Scope()
		for _, n := range sc.Names() {
			tn, ok := sc.Lookup(n).(*types.TypeName)
			if !ok || tn.IsAlias() {
				continue
			}
			named, ok := tn.Type().(*types.Named)
			if !ok || named.TypeParams().Len() > 0 {
				continue
			}
			if it, ok := named.Underlying().(*types.Interface); ok {
				if it.NumMethods() > 0 {
					ifaces = append(ifaces, tn)
				}
			} else {
				concretes = append(concretes, tn)
			}
		}
	}
	out.Implementers = map[string][]string{}
	for _, i := range ifaces {
		it := i.Type().Underlying().(*types.Interface)
		key := i.Pkg().Path() + "." + i.Name()
		impls := []string{}
		for _, c := range concretes {
			if types.Implements(c.Type(), it) || types.Implements(types.NewPointer(c.Type()), it) {
				impls = append(impls, c.Pkg().Path()+"."+c.Name())
			}
		}
		out.Implementers[key] = impls
	}
	sort.Strings(out.CallFiles)
	enc := json.NewEncoder(os.Stdout)
	_ = enc.Encode(out)
}
