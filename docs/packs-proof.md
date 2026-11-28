# Java and Python packs measured against SCIP truth

This is a measurement. The bars below were set before the first run and are not changed after it. A metric under its
bar by any amount is a miss, and nothing here was tuned to reach a bar: the packs, the resolvers and the engine are
untouched by the change that adds this file.

## Verdicts

The verdict line of each language is under its heading below, decided by the worst of three runs of each of its two
repos. Both are no.

Java misses one bar: call recall on jackson-databind (83.79% against 85%). Every other Java metric on both repos meets
its bar. Python meets both precision bars on both repos and misses symbol recall (all three kinds, both repos) and
call recall (65.02% and 66.60% against 70%).

## Bars, as written by the maintainer on 2026-11-22

Worst of three runs, per repo. They are not changed after the first run.

- Symbols (Java and Python): precision and recall at least 97% for functions, methods and classes, against SCIP
  definitions.
- Java calls: high-confidence edges at least 99% precision; all call edges to in-repo targets at least 85% recall,
  against SCIP references.
- Python calls: high-confidence edges at least 99% precision; low-confidence edges (level 3) at least 90% precision;
  overall recall at least 70% of SCIP call references to in-repo targets.

The scoring rules the maintainer set on 2026-11-23, before any run:

- SCIP local symbols and self-recursive calls are mapped, not left out. A reference whose SCIP target is a `local`
  symbol (a lambda, a method of an anonymous class) stays in the truth and is mapped onto our symbol for that body
  where one exists (the anonymous and enum-constant body methods); where we have no symbol for it, it counts as a
  miss. Self-recursive calls stay in the truth too; the graph leaves them out, so they count against recall. The
  report counts both groups separately.
- Low-confidence precision is per call site. A site with N same-arity overloads gives N low edges and is correct when
  the true target is among them.
- Java lambdas and method references are measured as they are, and the gap is reported with counts.

## What was measured

Two public repos per language, pinned in `evals/packs/repos.json` (name, URL, full SHA):

- Java, `mybatis-3`: https://github.com/mybatis/mybatis-3.git at `e988edd61fa44489f256c6d497e3d013305e93ad`. Maven, 1,407
  `.java` files. Plain object code, annotations and a hand-written SQL mapping layer.
- Java, `jackson-databind`: https://github.com/FasterXML/jackson-databind.git at
  `949188f567b60b88851f4898eeb9bc82d098cfbe`. Maven, 1,440 `.java` files. Generics, overload-heavy, many anonymous
  classes and nested types.
- Python, `django` (mostly not annotated): https://github.com/django/django.git at
  `f14af5a88472ca10e2e94b37d6c17ee48cbdeb4d`. 2,943 `.py` files in the pack's index.
- Python, `prefect` (mostly annotated): https://github.com/PrefectHQ/prefect.git at
  `ba45ac194f5aa918935b86388ee9651950fb06d6`. 1,959 `.py` files in the pack's index (the repo also holds a TypeScript
  app, which is not scored here).

Dropped candidates:

- `pydantic`: `scip-python` indexed only 55 of its files, because the repo's own pyright configuration limits the
  indexer to its package; that is not a set of 1,000 to 5,000 files. The index was stopped and the repo replaced.
- `commons-lang` was not run: it has 647 `.java` files, below the range.
- The first truth for `prefect` was made without the repo's source roots on the Python path, so `scip-python` could not
  resolve the repo's own imports (a high-confidence precision of 49.97% followed, which was the truth, not the pack).
  The truth was made again with the roots named in `evals/packs/repos.json` (`pythonPath`); the repo was kept.
  No third-party repo was patched.

Truth: `scip-java` 0.12.3 (JDK 21, the repos' own Maven wrapper) and `scip-python` 0.6.8 (Python 3.12, a virtual
environment per repo holding the packages in `pip` of `repos.json`), one index per repo, kept outside git. Machine:
Apple M3 Pro, 11 cores, 18 GiB, macOS on arm64, Node 26.13.0, nothing else heavy running. Each run is two `gantry index
--dump` runs of the repo, one without `--scip` and one with it, each with `CLAUDE_PLUGIN_DATA` set to a new temporary
folder; the graph of the run without `--scip` is the one scored. Wall time is that of the whole process, peak memory
comes from `/usr/bin/time`.

To reproduce one repo (clones and SCIP files go outside this repository):

```
pnpm build
GANTRY_OSS_DIR=<dir> pnpm eval:clone --repos evals/packs/repos.json --only mybatis-3
GANTRY_OSS_DIR=<dir> GANTRY_PACKS_TRUTH_DIR=<dir> JAVA_HOME=<jdk 21> GANTRY_SCIP_JAVA=<scip-java> \
  pnpm eval:packs --truth --only mybatis-3 --runs 3
```

`GANTRY_SCIP_PYTHON` and `GANTRY_PACKS_PYTHON` name the Python indexer and interpreter for the Python repos. The script
prints the report text below; `--report` and `--json` write it and the results to files.

## How a run is scored

- Scored files: those the graph holds and the index has a document for. The report counts the others.
- Symbols: precision and recall of functions, methods and classes (also interfaces and enums for Java, which are
  reported but are not part of the bar) against SCIP definitions. A definition is mapped onto the innermost symbol of
  its file that holds its line and is spelled like it. Recall counts distinct graph symbols found, over the
  definitions of the truth, so two definitions that map onto one graph symbol find it once. A definition that no
  source text declares (an implicit default constructor, an enum's `values`) is not a definition of the truth and is
  counted apart.
- Calls: a truth call is a SCIP reference to a function, method or constructor of the repo, from the innermost symbol
  that holds the line. Recall is over unique (caller, target) pairs against the graph's `calls` edges of any
  confidence. High-confidence precision is per edge. Low-confidence precision is per call site. Edges are split by
  level and confidence.
- Python calls need a `(` after the name. A class called as `Foo(...)` is a call of `Foo.__init__` when `Foo` declares
  it; when it does not, the index names no callee, the site is not in the truth, and an edge of the graph at that
  site is not scored (both counted).
- A reference to a Java method whose name is followed by `=` is an element of an annotation, not a call; it is left
  out and counted.
- Worst of three runs: the smallest ratio of each metric. Ratios are shown cut, never rounded up, with their counts,
  and compared with the bar as integers.

### Changes to the scorer after a first result

Bugs of the scorer were found by reading results. Every run below was taken after the last of them.

- Java annotation elements counted as calls. A reference to an element of an annotation (`name = ...` inside
  `@Annotation(...)`) names a method of an annotation type and was counted as a call to a symbol the pack does not
  have. They are now left out of the truth and counted. mybatis-3 call recall went from 85.24% (13269/15566) to 88.64%
  (13269/14968); precision did not change. This change raises recall, which is stated here so it is visible. In a
  later review the count of these references was found to include assigned fields and locals, because the `=` test
  ran before the test that the reference is a method; the test now runs after it. The count went from 13,750 to 3,348
  on jackson-databind and from 4,022 to 982 on mybatis-3, and no score moved.
- Python symbols defined more than once kept only the first definition. The index defines an overloaded function once
  and gives each later `def` as a read of the same symbol. The scorer now takes a `def` or `class` right before a name
  as a definition whatever role the index gives it, and a call matches any of the definitions of its target. On
  prefect, the first version of the scorer gave high-confidence call precision 96.15% (21789/22660), recall 64.46%
  (27717/42995), function symbol precision 98.99% (10075/10177) and method precision 99.39% (16693/16795); after, 99.38%
  (22525/22665), 66.60% (28468/42741), 99.99% (10176/10177) and 99.96% (16789/16795). On django, recall went from
  64.91% (28279/43560) to 65.02% (28279/43489).
- Symbol recall counted a graph symbol twice when two definitions of the truth mapped onto it, which is in the pack's
  favor. It now counts distinct graph symbols. Recall moved down: django classes 72.86% (8122/11146) to 72.86%
  (8121/11146), prefect functions 86.02% (10177/11830) to 86.01% (10176/11830), prefect methods 80.37%
  (16791/20890) to 80.36% (16789/20890). No verdict changed.
- The wording of the causes for symbols declared inside a function (no change of any number).

## Java

Bar met: no

Peak memory and wall time are the worst of the six processes of a repo.

### mybatis-3

Every bar is met on this repo. The closest is class recall at 97.71% (bar 97%); call recall is 88.64% (bar 85%).

```
mybatis-3 (java) at e988edd61fa44489f256c6d497e3d013305e93ad
  files indexed 1407; scored 1406; without a document in the index 1; documents of the index for files not indexed 0
  truth definitions 10452; implicit definitions left out of them 850; annotation elements left out of the calls 982; class calls with no initializer, not in the truth 0
  the runs gave the same scores: yes
  run 1
    without --scip: 15.2 s, peak 1009 MB
    with --scip: 15.2 s, peak 1118 MB; 1406 documents, 22562 edges, 104159 unmapped, 5823 other references, 0 stale
    precise-mode call edges that are calls of the truth: 12302/12553
    symbols
      method: precision 100.00% (8663/8663), recall 98.16% (8663/8825)
      class: precision 100.00% (1197/1197), recall 97.71% (1197/1225)
      interface: precision 100.00% (362/362), recall 100.00% (362/362)
      enum: precision 100.00% (40/40), recall 100.00% (40/40)
    calls
      truth calls 14968: self-recursive 20, through a local symbol 0 (no symbol of ours: 0), reachable by the graph 14072
      recall 88.64% (13269/14968)
      matched by: level 2 13269, high 11865, low 1404
      precision, all edges 85.30% (13269/15555)
      precision, high 99.80% (11865/11888)
      precision, low, per site 99.88% (1710/1712); per edge 38.28% (1404/3667)
      precision, level 2 85.30% (13269/15555)
      precision, level 2, high 99.80% (11865/11888)
      precision, level 2, low 38.28% (1404/3667)
      edges not scored (a class called with no initializer to name): 0
  run 2
    without --scip: 15.0 s, peak 1008 MB
    with --scip: 15.2 s, peak 1113 MB; 1406 documents, 22562 edges, 104159 unmapped, 5823 other references, 0 stale
    precise-mode call edges that are calls of the truth: 12302/12553
    symbols
      method: precision 100.00% (8663/8663), recall 98.16% (8663/8825)
      class: precision 100.00% (1197/1197), recall 97.71% (1197/1225)
      interface: precision 100.00% (362/362), recall 100.00% (362/362)
      enum: precision 100.00% (40/40), recall 100.00% (40/40)
    calls
      truth calls 14968: self-recursive 20, through a local symbol 0 (no symbol of ours: 0), reachable by the graph 14072
      recall 88.64% (13269/14968)
      matched by: level 2 13269, high 11865, low 1404
      precision, all edges 85.30% (13269/15555)
      precision, high 99.80% (11865/11888)
      precision, low, per site 99.88% (1710/1712); per edge 38.28% (1404/3667)
      precision, level 2 85.30% (13269/15555)
      precision, level 2, high 99.80% (11865/11888)
      precision, level 2, low 38.28% (1404/3667)
      edges not scored (a class called with no initializer to name): 0
  run 3
    without --scip: 15.2 s, peak 1015 MB
    with --scip: 15.3 s, peak 1114 MB; 1406 documents, 22562 edges, 104159 unmapped, 5823 other references, 0 stale
    precise-mode call edges that are calls of the truth: 12302/12553
    symbols
      method: precision 100.00% (8663/8663), recall 98.16% (8663/8825)
      class: precision 100.00% (1197/1197), recall 97.71% (1197/1225)
      interface: precision 100.00% (362/362), recall 100.00% (362/362)
      enum: precision 100.00% (40/40), recall 100.00% (40/40)
    calls
      truth calls 14968: self-recursive 20, through a local symbol 0 (no symbol of ours: 0), reachable by the graph 14072
      recall 88.64% (13269/14968)
      matched by: level 2 13269, high 11865, low 1404
      precision, all edges 85.30% (13269/15555)
      precision, high 99.80% (11865/11888)
      precision, low, per site 99.88% (1710/1712); per edge 38.28% (1404/3667)
      precision, level 2 85.30% (13269/15555)
      precision, level 2, high 99.80% (11865/11888)
      precision, level 2, low 38.28% (1404/3667)
      edges not scored (a class called with no initializer to name): 0
  worst of 3 runs: wall time 15.3 s, peak 1118 MB
    symbol precision, method: 100.00% (8663/8663), bar 97%, met
    symbol recall, method: 98.16% (8663/8825), bar 97%, met
    symbol precision, class: 100.00% (1197/1197), bar 97%, met
    symbol recall, class: 97.71% (1197/1225), bar 97%, met
    high-confidence call precision: 99.80% (11865/11888), bar 99%, met
    call recall: 88.64% (13269/14968), bar 85%, met
  causes of misses (first run)
    symbol recall: method: no symbol: 125
    symbol recall: method: declared inside a function: 37
    symbol recall: class: declared inside a function: 28
    local definitions 85, mapped 85; implicit definitions 850
    call recall: target is an implicit definition (a default constructor or an enum's own method): no symbol: 740
    call recall: the graph has no edge from the caller at the site: 539
    call recall: the graph has another target at the site: 194
    call recall: target has no symbol of ours: 135
    call recall: method reference: 70
    call recall: self-recursive call (the graph leaves it out): 20
    call recall: target is declared inside a function: 1
      no edge, shape member: 395
      no edge, shape bare: 144
      another target, edge of level 2, high: 112
      another target, edge of level 2, low: 82
    call precision: high: the index names another symbol of the repo at the site: 13
    call precision: high: the index has no call at the site: 10
    call precision: low: the index names another symbol of the repo at the site: 2
      wrong edges of level 2, low: 2263
      wrong edges of level 2, high: 23
```

### jackson-databind

One bar is missed on this repo: call recall is 83.79% (38723/46209) against 85%. The other metrics are met.

```
jackson-databind (java) at 949188f567b60b88851f4898eeb9bc82d098cfbe
  files indexed 1440; scored 1439; without a document in the index 1; documents of the index for files not indexed 1
  truth definitions 29910; implicit definitions left out of them 3884; annotation elements left out of the calls 3348; class calls with no initializer, not in the truth 0
  the runs gave the same scores: yes
  run 1
    without --scip: 49.4 s, peak 2966 MB
    with --scip: 49.1 s, peak 2638 MB; 1439 documents, 65762 edges, 262667 unmapped, 11980 other references, 26 stale
    precise-mode call edges that are calls of the truth: 36082/37710
    symbols
      method: precision 99.97% (23057/23063), recall 99.64% (23057/23140)
      class: precision 99.98% (6224/6225), recall 99.91% (6224/6229)
      interface: precision 100.00% (284/284), recall 100.00% (284/284)
      enum: precision 100.00% (257/257), recall 100.00% (257/257)
    calls
      truth calls 46209: self-recursive 49, through a local symbol 4 (no symbol of ours: 0), reachable by the graph 44168
      recall 83.79% (38723/46209)
      matched by: level 2 38723, high 29218, low 9505
      precision, all edges 27.39% (38723/141346)
      precision, high 99.78% (29218/29282)
      precision, low, per site 98.06% (12391/12635); per edge 8.48% (9505/112064)
      precision, level 2 27.39% (38723/141346)
      precision, level 2, high 99.78% (29218/29282)
      precision, level 2, low 8.48% (9505/112064)
      edges not scored (a class called with no initializer to name): 0
  run 2
    without --scip: 49.1 s, peak 2262 MB
    with --scip: 49.3 s, peak 2730 MB; 1439 documents, 65762 edges, 262667 unmapped, 11980 other references, 26 stale
    precise-mode call edges that are calls of the truth: 36082/37710
    symbols
      method: precision 99.97% (23057/23063), recall 99.64% (23057/23140)
      class: precision 99.98% (6224/6225), recall 99.91% (6224/6229)
      interface: precision 100.00% (284/284), recall 100.00% (284/284)
      enum: precision 100.00% (257/257), recall 100.00% (257/257)
    calls
      truth calls 46209: self-recursive 49, through a local symbol 4 (no symbol of ours: 0), reachable by the graph 44168
      recall 83.79% (38723/46209)
      matched by: level 2 38723, high 29218, low 9505
      precision, all edges 27.39% (38723/141346)
      precision, high 99.78% (29218/29282)
      precision, low, per site 98.06% (12391/12635); per edge 8.48% (9505/112064)
      precision, level 2 27.39% (38723/141346)
      precision, level 2, high 99.78% (29218/29282)
      precision, level 2, low 8.48% (9505/112064)
      edges not scored (a class called with no initializer to name): 0
  run 3
    without --scip: 49.7 s, peak 2704 MB
    with --scip: 48.7 s, peak 3160 MB; 1439 documents, 65762 edges, 262667 unmapped, 11980 other references, 26 stale
    precise-mode call edges that are calls of the truth: 36082/37710
    symbols
      method: precision 99.97% (23057/23063), recall 99.64% (23057/23140)
      class: precision 99.98% (6224/6225), recall 99.91% (6224/6229)
      interface: precision 100.00% (284/284), recall 100.00% (284/284)
      enum: precision 100.00% (257/257), recall 100.00% (257/257)
    calls
      truth calls 46209: self-recursive 49, through a local symbol 4 (no symbol of ours: 0), reachable by the graph 44168
      recall 83.79% (38723/46209)
      matched by: level 2 38723, high 29218, low 9505
      precision, all edges 27.39% (38723/141346)
      precision, high 99.78% (29218/29282)
      precision, low, per site 98.06% (12391/12635); per edge 8.48% (9505/112064)
      precision, level 2 27.39% (38723/141346)
      precision, level 2, high 99.78% (29218/29282)
      precision, level 2, low 8.48% (9505/112064)
      edges not scored (a class called with no initializer to name): 0
  worst of 3 runs: wall time 49.7 s, peak 3160 MB
    symbol precision, method: 99.97% (23057/23063), bar 97%, met
    symbol recall, method: 99.64% (23057/23140), bar 97%, met
    symbol precision, class: 99.98% (6224/6225), bar 97%, met
    symbol recall, class: 99.91% (6224/6229), bar 97%, met
    high-confidence call precision: 99.78% (29218/29282), bar 99%, met
    call recall: 83.79% (38723/46209), bar 85%, MISSED
  causes of misses (first run)
    symbol recall: method: no symbol: 81
    symbol recall: class: declared inside a function: 4
    symbol recall: method: declared inside a function: 2
    symbol recall: class: no symbol: 1
    local definitions 229, mapped 229; implicit definitions 3884
    call recall: the graph has no edge from the caller at the site: 4591
    call recall: target is an implicit definition (a default constructor or an enum's own method): no symbol: 1918
    call recall: the graph has another target at the site: 821
    call recall: target has no symbol of ours: 73
    call recall: self-recursive call (the graph leaves it out): 49
    call recall: method reference: 33
    call recall: target is declared inside a function: 1
      no edge, shape member: 3290
      no edge, shape bare: 1286
      no edge, shape construct: 15
      another target, edge of level 2, high: 438
      another target, edge of level 2, low: 383
    call precision: low: the index names another symbol of the repo at the site: 233
    call precision: high: the index names another symbol of the repo at the site: 46
    call precision: high: the index has no call at the site: 16
    call precision: low: the index has no call at the site: 11
    call precision: high: the index names a target that has no symbol of ours: 2
      wrong edges of level 2, low: 102559
      wrong edges of level 2, high: 64
```

### Java: where the misses are

Every Java `calls` edge is level 2 (the type resolver, which also resolves names within a package), so there is no level
1 or level 3 edge to score. Precision is not the problem: high-confidence edges are 99.78% and 99.80% precise, and low
edges are right at 98.06% and 99.88% of their call sites. The one missed bar is recall on jackson-databind.

The largest causes of the 7,486 jackson-databind truth calls with no matching edge, in order:

- 4,591 calls where the graph has no edge from the caller at that site at all: 3,290 calls on a receiver (`x.m()`),
  1,286 bare calls (`m()`, or a name from a static import) and 15 constructions. The resolver gives no edge when the
  receiver's type is not known or not in the repo; the scorer does not say which of those applied.
- 1,918 calls of an implicit definition: a default constructor that the class never declares, or an enum's own method.
  The pack has no symbol for them, and the index defines them at the name of the class. mybatis-3 has 740 of its 1,699
  misses here, also the largest cause there.
- 821 sites where the graph has an edge to another target (438 `high`, 383 `low`): a wrong overload or the wrong
  supertype.
- 73 calls of a target that has no symbol of ours (on mybatis-3 the same cause, 135 calls, is calls of the elements of
  annotation types, checked by name), 49 self-recursive calls (rule: counted against recall; mybatis-3 has 20), 33
  method references (mybatis-3 has 70) and 1 target declared inside a function.

Lambdas and method references: method references are measured as they are. They are 33 of jackson-databind's misses and
70 of mybatis-3's, and are the only misses of their kind. Calls inside a lambda belong to the method around it and are
not separate truth calls. No call is lost for lack of a symbol for a `local` target: of the 229 local definitions of
jackson-databind (methods of anonymous classes) all 229 map onto the pack's anonymous-body symbols, and its 4 truth
calls through a local symbol all have one; mybatis-3 has 85 of 85 mapped and no such call.

Symbols of Java are all above the bar. The least is class recall on mybatis-3 at 97.71%: 28 classes declared inside
method bodies, which the pack does not make symbols.

## Python

Bar met: no

### django

Missed on this repo: recall of functions (90.72%), methods (94.74%) and classes (72.86%), and call recall (65.02%).
Both precision bars are met.

```
django (python) at f14af5a88472ca10e2e94b37d6c17ee48cbdeb4d
  files indexed 2943; scored 2941; without a document in the index 2; documents of the index for files not indexed 0
  truth definitions 44188; implicit definitions left out of them 0; annotation elements left out of the calls 0; class calls with no initializer, not in the truth 11472
  the runs gave the same scores: yes
  run 1
    without --scip: 79.1 s, peak 3336 MB
    with --scip: 79.8 s, peak 3347 MB; 2941 documents, 63027 edges, 355820 unmapped, 39651 other references, 1 stale
    precise-mode call edges that are calls of the truth: 32033/32734
    symbols
      function: precision 100.00% (1927/1927), recall 90.72% (1927/2124)
      method: precision 100.00% (29294/29294), recall 94.74% (29294/30918)
      class: precision 100.00% (8121/8121), recall 72.86% (8121/11146)
    calls
      truth calls 43489: self-recursive 80, through a local symbol 0 (no symbol of ours: 0), reachable by the graph 42562
      recall 65.02% (28279/43489)
      matched by: level 3 14960, low 14960, high 13319, level 2 13319
      precision, all edges 97.90% (28279/28884)
      precision, high 99.35% (13319/13405)
      precision, low, per site 96.64% (19938/20630); per edge 96.64% (14960/15479)
      precision, level 2 99.35% (13319/13405)
      precision, level 3 96.64% (14960/15479)
      precision, level 2, high 99.35% (13319/13405)
      precision, level 3, low 96.64% (14960/15479)
      edges not scored (a class called with no initializer to name): 412
  run 2
    without --scip: 78.9 s, peak 2994 MB
    with --scip: 79.6 s, peak 3496 MB; 2941 documents, 63027 edges, 355820 unmapped, 39651 other references, 1 stale
    precise-mode call edges that are calls of the truth: 32033/32734
    symbols
      function: precision 100.00% (1927/1927), recall 90.72% (1927/2124)
      method: precision 100.00% (29294/29294), recall 94.74% (29294/30918)
      class: precision 100.00% (8121/8121), recall 72.86% (8121/11146)
    calls
      truth calls 43489: self-recursive 80, through a local symbol 0 (no symbol of ours: 0), reachable by the graph 42562
      recall 65.02% (28279/43489)
      matched by: level 3 14960, low 14960, high 13319, level 2 13319
      precision, all edges 97.90% (28279/28884)
      precision, high 99.35% (13319/13405)
      precision, low, per site 96.64% (19938/20630); per edge 96.64% (14960/15479)
      precision, level 2 99.35% (13319/13405)
      precision, level 3 96.64% (14960/15479)
      precision, level 2, high 99.35% (13319/13405)
      precision, level 3, low 96.64% (14960/15479)
      edges not scored (a class called with no initializer to name): 412
  run 3
    without --scip: 79.1 s, peak 2560 MB
    with --scip: 80.4 s, peak 3315 MB; 2941 documents, 63027 edges, 355820 unmapped, 39651 other references, 1 stale
    precise-mode call edges that are calls of the truth: 32033/32734
    symbols
      function: precision 100.00% (1927/1927), recall 90.72% (1927/2124)
      method: precision 100.00% (29294/29294), recall 94.74% (29294/30918)
      class: precision 100.00% (8121/8121), recall 72.86% (8121/11146)
    calls
      truth calls 43489: self-recursive 80, through a local symbol 0 (no symbol of ours: 0), reachable by the graph 42562
      recall 65.02% (28279/43489)
      matched by: level 3 14960, low 14960, high 13319, level 2 13319
      precision, all edges 97.90% (28279/28884)
      precision, high 99.35% (13319/13405)
      precision, low, per site 96.64% (19938/20630); per edge 96.64% (14960/15479)
      precision, level 2 99.35% (13319/13405)
      precision, level 3 96.64% (14960/15479)
      precision, level 2, high 99.35% (13319/13405)
      precision, level 3, low 96.64% (14960/15479)
      edges not scored (a class called with no initializer to name): 412
  worst of 3 runs: wall time 80.4 s, peak 3496 MB
    symbol precision, function: 100.00% (1927/1927), bar 97%, met
    symbol recall, function: 90.72% (1927/2124), bar 97%, MISSED
    symbol precision, method: 100.00% (29294/29294), bar 97%, met
    symbol recall, method: 94.74% (29294/30918), bar 97%, MISSED
    symbol precision, class: 100.00% (8121/8121), bar 97%, met
    symbol recall, class: 72.86% (8121/11146), bar 97%, MISSED
    high-confidence call precision: 99.35% (13319/13405), bar 99%, met
    low-confidence call precision (per site): 96.64% (19938/20630), bar 90%, met
    call recall: 65.02% (28279/43489), bar 70%, MISSED
  causes of misses (first run)
    symbol recall: class: declared inside a function: 2972
    symbol recall: method: declared inside a function: 1585
    symbol recall: function: declared inside a function: 179
    symbol recall: class: no symbol: 51
    symbol recall: method: no symbol: 39
    symbol recall: function: no symbol: 18
    symbol recall: class: the graph has the symbol under another kind: 1
    local definitions 0, mapped 0; implicit definitions 0
    call recall: the graph has no edge from the caller at the site: 13689
    call recall: the graph has another target at the site: 594
    call recall: target is declared inside a function: 531
    call recall: call outside every function (no caller symbol): 283
    call recall: self-recursive call (the graph leaves it out): 80
    call recall: target has no symbol of ours: 33
      no edge, shape member: 8178
      no edge, shape construct: 5375
      no edge, shape bare: 136
      another target, edge of level 2, high: 417
      another target, edge of level 3, low: 177
    call precision: low: the index has no call at the site: 663
    call precision: high: the index has no call at the site: 51
    call precision: high: the index names a target outside the repo at the site: 21
    call precision: low: the index names another symbol of the repo at the site: 15
    call precision: low: the index names a target outside the repo at the site: 14
    call precision: high: the index names another symbol of the repo at the site: 13
    call precision: high: the index names a target that has no symbol of ours: 1
      wrong edges of level 3, low: 519
      wrong edges of level 2, high: 86
```

### prefect

Missed on this repo: recall of functions (86.01%), methods (80.36%) and classes (82.78%), and call recall (66.60%).
Both precision bars are met.

```
prefect (python) at ba45ac194f5aa918935b86388ee9651950fb06d6
  files indexed 1959; scored 1940; without a document in the index 19; documents of the index for files not indexed 17
  truth definitions 37414; implicit definitions left out of them 0; annotation elements left out of the calls 0; class calls with no initializer, not in the truth 11242
  the runs gave the same scores: yes
  run 1
    without --scip: 85.4 s, peak 3974 MB
    with --scip: 86.5 s, peak 3844 MB; 1940 documents, 64378 edges, 414805 unmapped, 23036 other references, 0 stale
    precise-mode call edges that are calls of the truth: 36453/37025
    symbols
      function: precision 99.99% (10176/10177), recall 86.01% (10176/11830)
      method: precision 99.96% (16789/16795), recall 80.36% (16789/20890)
      class: precision 100.00% (3886/3886), recall 82.78% (3886/4694)
    calls
      truth calls 42741: self-recursive 70, through a local symbol 0 (no symbol of ours: 0), reachable by the graph 39578
      recall 66.60% (28468/42741)
      matched by: high 22525, level 2 22525, level 3 5943, low 5943
      precision, all edges 99.30% (28468/28667)
      precision, high 99.38% (22525/22665)
      precision, low, per site 98.84% (6826/6906); per edge 99.01% (5943/6002)
      precision, level 2 99.38% (22525/22665)
      precision, level 3 99.01% (5943/6002)
      precision, level 2, high 99.38% (22525/22665)
      precision, level 3, low 99.01% (5943/6002)
      edges not scored (a class called with no initializer to name): 110
  run 2
    without --scip: 85.1 s, peak 3788 MB
    with --scip: 86.1 s, peak 3836 MB; 1940 documents, 64378 edges, 414805 unmapped, 23036 other references, 0 stale
    precise-mode call edges that are calls of the truth: 36453/37025
    symbols
      function: precision 99.99% (10176/10177), recall 86.01% (10176/11830)
      method: precision 99.96% (16789/16795), recall 80.36% (16789/20890)
      class: precision 100.00% (3886/3886), recall 82.78% (3886/4694)
    calls
      truth calls 42741: self-recursive 70, through a local symbol 0 (no symbol of ours: 0), reachable by the graph 39578
      recall 66.60% (28468/42741)
      matched by: high 22525, level 2 22525, level 3 5943, low 5943
      precision, all edges 99.30% (28468/28667)
      precision, high 99.38% (22525/22665)
      precision, low, per site 98.84% (6826/6906); per edge 99.01% (5943/6002)
      precision, level 2 99.38% (22525/22665)
      precision, level 3 99.01% (5943/6002)
      precision, level 2, high 99.38% (22525/22665)
      precision, level 3, low 99.01% (5943/6002)
      edges not scored (a class called with no initializer to name): 110
  run 3
    without --scip: 85.4 s, peak 3962 MB
    with --scip: 86.0 s, peak 3960 MB; 1940 documents, 64378 edges, 414805 unmapped, 23036 other references, 0 stale
    precise-mode call edges that are calls of the truth: 36453/37025
    symbols
      function: precision 99.99% (10176/10177), recall 86.01% (10176/11830)
      method: precision 99.96% (16789/16795), recall 80.36% (16789/20890)
      class: precision 100.00% (3886/3886), recall 82.78% (3886/4694)
    calls
      truth calls 42741: self-recursive 70, through a local symbol 0 (no symbol of ours: 0), reachable by the graph 39578
      recall 66.60% (28468/42741)
      matched by: high 22525, level 2 22525, level 3 5943, low 5943
      precision, all edges 99.30% (28468/28667)
      precision, high 99.38% (22525/22665)
      precision, low, per site 98.84% (6826/6906); per edge 99.01% (5943/6002)
      precision, level 2 99.38% (22525/22665)
      precision, level 3 99.01% (5943/6002)
      precision, level 2, high 99.38% (22525/22665)
      precision, level 3, low 99.01% (5943/6002)
      edges not scored (a class called with no initializer to name): 110
  worst of 3 runs: wall time 86.5 s, peak 3974 MB
    symbol precision, function: 99.99% (10176/10177), bar 97%, met
    symbol recall, function: 86.01% (10176/11830), bar 97%, MISSED
    symbol precision, method: 99.96% (16789/16795), bar 97%, met
    symbol recall, method: 80.36% (16789/20890), bar 97%, MISSED
    symbol precision, class: 100.00% (3886/3886), bar 97%, met
    symbol recall, class: 82.78% (3886/4694), bar 97%, MISSED
    high-confidence call precision: 99.38% (22525/22665), bar 99%, met
    low-confidence call precision (per site): 98.84% (6826/6906), bar 90%, met
    call recall: 66.60% (28468/42741), bar 70%, MISSED
  causes of misses (first run)
    symbol recall: method: declared inside a function: 4078
    symbol recall: function: declared inside a function: 1644
    symbol recall: class: declared inside a function: 793
    symbol recall: method: no symbol: 21
    symbol recall: function: no symbol: 9
    symbol recall: class: the graph has the symbol under another kind: 8
    symbol recall: class: no symbol: 7
    local definitions 0, mapped 0; implicit definitions 0
    call recall: the graph has no edge from the caller at the site: 10977
    call recall: target is declared inside a function: 2460
    call recall: target is in a file the pack does not index: 383
    call recall: call outside every function (no caller symbol): 182
    call recall: the graph has another target at the site: 133
    call recall: self-recursive call (the graph leaves it out): 70
    call recall: target has no symbol of ours: 68
      no edge, shape member: 9669
      no edge, shape bare: 944
      no edge, shape construct: 364
      another target, edge of level 2, high: 104
      another target, edge of level 3, low: 29
    call precision: high: the index has no call at the site: 131
    call precision: low: the index names a target outside the repo at the site: 34
    call precision: low: the index has no call at the site: 33
    call precision: low: the index names another symbol of the repo at the site: 13
    call precision: high: the index names a target outside the repo at the site: 6
    call precision: high: the index names a target that has no symbol of ours: 2
    call precision: high: the index names another symbol of the repo at the site: 1
      wrong edges of level 2, high: 140
      wrong edges of level 3, low: 59
```

### Python: where the misses are

Precision holds at every level that is scored: level 2 edges (all `high`) are 99.35% and 99.38% precise, and level 3
edges (all `low`) are right at 96.64% and 98.84% of their call sites, against a bar of 90%. The misses are recall.

Symbols. Almost all of the symbol misses are definitions that sit inside the body of a function or method. On django:
2,972 of the 3,024 missed classes, 1,585 methods and 179 functions. On prefect: 793 classes, 4,078 methods and 1,644
functions. The pack's spec makes only top-level and class-body definitions symbols, so a helper or a test model
defined in a function body is not one (the index lists such a definition as a member of the enclosing class or
module). The remainder is small: on django 51 classes, 39 methods and 18 functions with no symbol and 1 class the
graph holds under another kind; on prefect 7 classes, 21 methods and 9 functions, and 8 classes under another kind.
Precision of symbols is at least 99.96% everywhere.

Calls. The largest cause on both repos is a call where the graph has no edge from the caller at the site: 13,689 of
15,210 missed calls on django and 10,977 of 14,273 on prefect. By shape, calls on a receiver dominate (8,178 on
django, 9,669 on prefect): the pack makes an edge only when the receiver's type is declared or follows from a value
assigned in the function, so a parameter without an annotation gives none; the mostly annotated repo has the same
cause as the other. Class constructions come next on django (5,375 calls of `Foo(...)` whose class does declare
`__init__`; the spec gives no edge for a class with several bases and no initializer of its own, a decorator or a
metaclass, and the scorer does not say which applied; prefect has 364) and bare names follow (136 on django, 944 on
prefect).

Other causes, with the level of the competing edge where there is one: sites where the graph holds another target
(django 594, of which 417 level 2 and 177 level 3; prefect 133, of which 104 level 2 and 29 level 3); targets declared
inside a function (531 and 2,460); calls outside every function, which the spec leaves without a caller (283 and
182); self-recursive calls (80 and 70); targets with no symbol of ours (33 and 68); and, on prefect only, 383 calls
whose target is in a file the pack does not index. Recall by level: of the truth calls matched, level 2 matched 13,319
on django and 22,525 on prefect, level 3 matched 14,960 and 5,943.

Class constructions of a class that declares no `__init__` (11,472 on django, 11,242 on prefect) are not in the truth
because the index names no callee; 412 and 110 edges of the graph at those sites are not scored.

Caveats of the truth. `scip-python` was run with the dependencies of the repos not installed except as listed in
`repos.json`, so what a call resolves to outside the repo is thin; only references to targets defined in the repo are
scored. For prefect the source roots of the repo and of its integration packages are on the interpreter's path, as an
editable install would put them. The precise-mode run (`--scip`) is recorded for each run and agrees with the truth
used here on 32,033 of 32,734 call edges on django and 36,453 of 37,025 on prefect; the difference was not examined.
