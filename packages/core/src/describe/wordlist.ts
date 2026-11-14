// English word test for the description validator (spec section 8, check 6). A token is an "ordinary word" when it is
//   - a word of 4 to 20 letters in the generated Bloom filter (wordlist.data.ts: Webster's Second International, 1934,
//     copyright lapsed, see scripts/build-wordlist.ts), or
//   - on the hand lists below (two- and three-letter words, programming and web terms the 1934 list lacks), or
//   - a regular derived form of one of those: plural, -ed, -ing, -er, -est, -ly, -able, -ness, -ment, -tion, ... and the
//     prefixes un-, re-, non-, pre-, de-, sub-, multi-, auto- and a few more.
// The filter is decoded lazily on first use (about 3 ms) and answers in ten probes. It has about 0.1% false positives.

import { bloomHashes, bloomIndex } from "./bloom.js";
import { WORD_BITS, WORD_BLOOM_BASE64, WORD_HASHES } from "./wordlist.data.js";

let bits: Uint8Array | null = null;
/** Milliseconds the one-time decode took (0 until first use); read by the performance test. */
export let wordlistInitMs = 0;

function init(): Uint8Array {
  if (bits === null) {
    const t0 = performance.now();
    const raw = Buffer.from(WORD_BLOOM_BASE64, "base64");
    bits = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    wordlistInitMs = performance.now() - t0;
  }
  return bits;
}

function inBloom(w: string): boolean {
  const b = init();
  const [h1, h2] = bloomHashes(w);
  for (let i = 0; i < WORD_HASHES; i++) {
    const idx = bloomIndex(h1, h2, i, WORD_BITS);
    if (((b[idx >> 3] as number) & (1 << (idx & 7))) === 0) return false;
  }
  return true;
}

const set = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

/** Two- and three-letter English words and common abbreviations. The generated list starts at four letters on purpose. */
const SHORT_WORDS = set(`
a am an as at be by do go he hi if in is it me my no of oh ok on or so to up us we id ip io os pc tv ui ux db ci cd qa pr st nd rd th
ms px em ai ml gc vm ci ab ad ah aw ax ay eh er ex fa hm ho la lo ma mi mu na nu oi ow pa pi re ta ya
aid act add age ago aim air all and any ape arc are arm art ash ask ate bad bag ban bar bat bay bed bee beg bet bid big
bin bit bow box boy bug bus but buy cab can cap car cat cop cow cry cub cup cut dad dam day den die dig dim dip dog dot
dry dub due dye ear eat egg ego end era eve eye fan far fat fed fee few fig fit fix fly fog for fun fur gap gas gem get
god got gum gun gut guy had hat her hid him hip his hit hot how hub hug ice ill ink inn its jam jar jaw job jog joy key
kid kit lab lag lap law lay led leg let lid lie lip lit log lot low mad man map mat may men met mid mix mob mud mug nap
net new nod nor not now nut oak odd off oil old one opt orb ore our out owe own pad pan pat paw pay pea pen pet pie pig
pin pit ply pod pop pot pro pub put rag ran rat raw ray red rid rim rip rob rod row rub rug run sad sat saw say sea see
set sew she shy sin sip sir sit six ski sky sly son sow spy sub sum sun tab tag tan tap tax tea ten the tie tin tip toe
too top toy try tub two urn use van vet via vow war was wax way web wed wet who why win wit won yes yet you zip zoo
api app bot cli cpu css csv dev dom env faq gif gpu gui hex html http ide jpg jwt lan log lru max min mvp nan npm null
orm pdf png rpc ram rom sdk sql ssh ssl svg tcp tls udp uri url usb uuid xml yml dns cdn cfg cmd dir doc exe fps lib msg
num obj ops pkg ref rgb seo sms str tmp ttl txt ver vpn wip xhr xss yaml cors csrf crud cron diff
`);

/** Programming and web terms, product names and abbreviations that Webster's Second International (1934) lacks. */
const TECH_WORDS = set(`
async await callback callbacks middleware plugin plugins webhook webhooks oauth regex regexp json yaml toml config configs
auth repo repos api apis url urls uuid uuids cron cli sdk ui ux db sql http https css html dom ssr csr spa pwa ajax xhr
websocket websockets localhost frontend backend fullstack codebase workflow workflows pipeline pipelines runtime
runtimes timestamp timestamps timezone timezones username usernames filename filenames pathname pathnames hostname
hostnames dirname basename sidebar navbar toolbar dropdown dropdowns checkbox checkboxes textbox textarea popup popups
modal modals tooltip tooltips toast toasts spinner spinners breadcrumb breadcrumbs favicon thumbnail thumbnails
screenshot screenshots onboarding backoff backoffs throttle throttled throttling debounce debounced debouncing
memoize memoized memoizing memoization serialize serialized serializing serialization deserialize deserialized
deserializing deserialization stringify stringified parse parsed parsing parser parsers tokenize tokenized tokenizer
tokenizers lexer lexers linter linters formatter formatters bundler bundlers transpile transpiled transpiler
minify minified minifier sourcemap sourcemaps polyfill polyfills shim shims stub stubs stubbed mock mocks mocked
fixture fixtures snapshot snapshots dedupe deduped deduplicate deduplicated deduplication refactor refactored
refactoring rollback rollbacks rollout rollouts upsert upserts upserted enum enums struct structs tuple tuples
boolean booleans bool int ints uint float floats double doubles bigint bigints string strings array arrays
nullable nullish undefined null nan json jsonl ndjson csv tsv xml yaml markdown readme changelog dockerfile makefile
lockfile lockfiles gitignore dotenv env envs typescript javascript nodejs node react reactjs nextjs vue angular svelte
redux vite webpack rollup esbuild tsup tsx jsx eslint prettier biome jest vitest mocha cypress playwright puppeteer
storybook graphql grpc protobuf thrift openapi swagger rest restful soap rpc trpc zod yup joi prisma drizzle knex
sequelize typeorm mongoose sqlite postgres postgresql mysql mariadb mongodb redis memcached dynamodb firestore
firebase supabase elasticsearch opensearch kafka rabbitmq nats sqs sns lambda cloudflare vercel netlify heroku
docker kubernetes helm terraform ansible nginx apache linux macos ios android windows ubuntu debian alpine bash zsh
powershell shell cmd git github gitlab bitbucket npm pnpm yarn npx pip pypi cargo gradle maven homebrew brew
chrome firefox safari edge webkit chromium electron tauri stripe paypal twilio sendgrid mailgun sentry datadog
slack discord telegram openai anthropic claude gpt llm llms embedding embeddings tokenizer prompt prompts rag
sha md hmac bcrypt argon scrypt pbkdf jwt jwks jws jwe saml oidc sso mfa totp otp csrf xss cors cookie cookies
httponly samesite base hex utf ascii unicode emoji emojis punycode urlencode urlencoded multipart formdata
blob blobs buffer buffers stream streams streaming readable writable iterator iterators generator generators
promise promises thenable observable observables subscriber subscribers publisher publishers emitter emitters
reducer reducers selector selectors dispatch dispatcher dispatchers store stores hook hooks mixin mixins decorator
decorators getter getters setter setters accessor accessors proxy proxies singleton singletons factory factories
adapter adapters facade facades visitor visitors lifecycle lifecycles namespace namespaces monorepo monorepos
submodule submodules subpath subpaths subtree subtrees workspace workspaces symlink symlinks hardlink inode
stdin stdout stderr argv argc env exit errno enoent eacces eexist sigint sigterm sigkill pid pids tty pty cwd
chmod chown mkdir rmdir tmpdir homedir cpu cpus gpu gpus ram rom ssd hdd ipc fifo lifo lru lfu ttl cdn dns dhcp tcp
udp ip ipv ssh ssl tls vpn lan wan nat mtu http2 ftp sftp smtp imap pop mime mimetype uri urn iri
tsconfig jsconfig package lockfile pnpm turbo turborepo nx lerna rush bazel
rerender rerenders rerendered rerendering prerender prerendered hydrate hydrated hydrating hydration lazyload
suspense fallback boundary boundaries portal portals ref refs prop props state states context contexts
useeffect usestate useref usememo usecallback usecontext usereducer
frontmatter slug slugs slugify slugified permalink permalinks sitemap sitemaps robots
cache caches cached caching uncached cacheable invalidate invalidated invalidation prefetch prefetched
prefetching preload preloaded preloading lazy eager idempotent idempotency atomic atomically
transactional transactionally concurrency concurrent concurrently mutex mutexes semaphore semaphores
lockless deadlock deadlocks livelock race races threadsafe worker workers threadpool microtask microtasks
macrotask eventloop tick ticks
autocomplete autosave autoscroll autofocus autofill autoplay autorun autogenerate autogenerated
login logins logout logouts signin signout signup signups username usernames passwd passcode passphrase
checkout checkouts paywall paywalls invoice invoices subscription subscriptions tenant tenants multitenant
onboard offboard offboarding feature flags flag toggles toggle rollouts canary canaries
metadata metrics telemetry analytics tracing traces logging logger loggers loglevel debug warn info trace fatal
stacktrace stacktraces breakpoint breakpoints sourcemap profiling profiler benchmark benchmarks microbenchmark
unittest unittests integration e2e endtoend smoke regression flaky flakiness coverage lcov istanbul
webhook endpoint endpoints route routes router routers routing handler handlers controller controllers
service services repository repositories entity entities model models schema schemas migration migrations
seed seeds seeding query queries mutation mutations resolver resolvers fragment fragments directive directives
pagination paginate paginated paginating cursor cursors offset limit offsets batch batches batched batching
queue queues enqueue enqueued enqueues enqueuing dequeue dequeued requeue requeued requeues requeuing
retry retries retried retrying reschedule rescheduled reschedules rescheduling
dedup dedupes wildcard wildcards glob globs globbing minimatch regexes backreference lookahead lookbehind
tokenization lexing lemmatize stemming stemmer stopword stopwords ngram ngrams bigram trigram levenshtein
minhash simhash jaccard cosine tfidf bm25 fts fts5 vec knn ann hnsw
codec codecs encode encoded encoder encoders decode decoded decoder decoders gzip gunzip zlib brotli deflate inflate
base64 base32 hexadecimal binary octal bitwise bitmask bitmasks bitfield bitflag endian bigendian littleendian
checksum checksums crc hash hashes hashed hashing rehash rehashed salt salts salted pepper nonce nonces
keypair keypairs keystore keychain keychains vault vaults secret secrets credential credentials passkey passkeys
tld tlds subdomain subdomains domain domains dnsname fqdn cname ipv4 ipv6 cidr loopback
html5 css3 ecmascript es6 es2015 wasm webassembly webgl webgpu canvas svg png jpeg jpg gif webp avif ico
readonly readwrite writeonly nonblocking blocking nonempty noop noops nop nops todo todos fixme hack hacks
utils util utility utilities helper helpers misc common shared lib libs libraries sdk sdks cli clis tui tuis gui guis
init inits initialise initialize initialised initialized initialising initializing reinit reinitialize
repl repls shebang transpiler compile compiled compiler compilers interpreter interpreters bytecode
cron crontab cronjob cronjobs scheduler schedulers daemon daemons cli subprocess subprocesses spawn spawned spawning
fork forked forking pipe piped piping redirect redirected redirects redirecting
dev devs prod staging sandbox sandboxes qa uat preprod localhost devtools devtool
app apps webapp webapps website websites webpage webpages homepage homepages landing dashboard dashboards
admin admins superuser superusers sudo root roles rbac acl acls
repo repos commit commits committed committing rebase rebased rebasing merge merged merging cherrypick
changeset changesets semver prerelease prereleases hotfix hotfixes backport backports
codemod codemods ast asts abstract syntax node nodes treeshake treeshaking deadcode
readme license licenses licensing copyright
tooltip dialog dialogs lightbox carousel carousels accordion accordions tabs tabbed tabset pager paginator
sparkline sparklines heatmap heatmaps treemap treemaps sankey scatterplot histogram histograms legend legends
tooltips gridline gridlines axis axes viewport viewports offscreen onscreen fullscreen minimap
drag draggable droppable dnd resize resizable resizer scrollbar scrollbars scrollable scrolled scrolling
keyboard keydown keyup keypress mouseover mouseout mousedown mouseup click clicks clicked double dblclick hover hovered
focus focused blur blurred submit submitted onclick onchange onsubmit
i18n l10n a11y locale locales localize localized localization translation translations rtl ltr
css scss sass less postcss tailwind flexbox grid stylesheet stylesheets classname classnames inline
dev ops devops sre ci cd cicd gitops
ok lol wip tbd faq api rest crud ctrl alt shift enter esc escape tab space backspace
tsx jsx mjs cjs mts cts dts ts js py rb go bash md txt
kb mb gb tb ms ns px rem em vh vw dpi fps hz khz mhz ghz
utc gmt iso epoch unix posix
nonexistent nonempty nonzero nonnull nonnegative
usd eur gbp jpy cad aud
`);

/**
 * More programming, web and everyday computing words the 1934 list lacks. Added after measuring false rejections on
 * honest descriptions (the committed corpus and a private set of real model output, counts only).
 */
const TECH_MORE = set(`
email emails database databases datastore datasets dataset timeout timeouts whitespace whitespaces newline newlines
shortcut shortcuts stopwatch keyset ids bytes byte kilobyte kilobytes megabyte megabytes gigabyte gigabytes payload payloads
stats statistic mtime ctime atime pii wal pkce aes rsa pem ansi ecdsa ecdh hkdf kdf sha md5 crc multi auto
params param args arg kwargs argv varargs vars var const let setup teardown bootstrap bootstrapped
online offline internet website websites webpage software hardware username usernames password passwords login
backup backups restore restored workflow spreadsheet smartphone laptop desktop mobile wifi bluetooth browser browsers
emoji podcast blog blogs tweet hashtag hyperlink hyperlinks metadata plugin touchscreen
dropdown slider tooltip popup sidebar navbar footer header headers scroll scrolling swipe tap pinch zoom touchpad
datetime uptime downtime lifetime realtime devops unmount unmounted unmounting rerender refetch reindex requeue
redo undo inline inlined iframe iframes viewport stylesheet typeface webfont sprite sprites bitmap pixel pixels
minify provision provisioned provisioning deprovision autoscale failover rollover cooldown unlink symlink
trie bitset heap heaps stack stacks graph graphs digest nonce salt hash
kanban scrum checklist checklists jsonld nosql ulid cuid nanoid gcm cbc ctr ecb cfb ofb dist src dir bin tmp plain commandline jws der csr ldap kerberos abac iam arn vpc ses gql cssom cst jit aot gc oom qps rps sla slo
sli mttr tdd bdd ddd dto dtos dao mvc mvvm ioc oop etl olap oltp acid bom crlf cr lf eol eof nul inf uid gid
vt100 ps sig
login logins logout webview webviews widget widgets gadget gadgets sprite thumbnail
unicode utf8 utf16 latin1 ascii codepoint codepoints grapheme graphemes surrogate surrogates
camelcase pascalcase snakecase kebabcase titlecase lowercase uppercase lowercased uppercased
prepend prepends prepended prepending append appends appended appending
truthy falsy nullish coalesce coalescing destructure destructured destructuring spread rest
lambda lambdas closure closures iife currying curried thunk thunks monad monads functor
runtime compile compiles compiled linkage linker bundle bundles chunk chunks chunked sharding shard shards
replica replicas replicate replicated replication leader follower quorum consensus
oauth2 openid redirect redirects callback callbacks scope scopes grant grants consent
cron crons cronjob scheduler schedulers timer timers interval intervals timeline timelines
changelog changelogs release releases semver versioning versioned prerelease
frontend frontends backend backends fullstack microservice microservices monolith monoliths
serverless lambda edge cdn origin origins
admin admins moderator moderators webmaster
lint linted linting linter linters autofix autofixed
openapi swagger jsonschema schema schemas validator validators validation validations
sanitize sanitized sanitizer sanitizers sanitizing sanitise
unsubscribe unsubscribed unsubscribes unsubscribing resubscribe
dedupe deduped dedupes deduping
checkbox checkboxes radio radios textfield textfields input inputs output outputs
placeholder placeholders autocomplete autocompleted
analytics pageview pageviews clickstream funnel funnels cohort cohorts
paginate paginated paginates paginating pagination
timestamps timestamped timezone timezones
sandboxed sandboxing sandboxes
readonly writable readable
hotkey hotkeys keybinding keybindings keymap keymaps keystroke keystrokes
stdlib stdio stdin stdout stderr
mutex mutexes spinlock
uint int8 int16 int32 int64 float32 float64
config configs configure configured configuring configuration configurations
dev prod stage staging preview previews
signup signups signin signout
namespace namespaces namespaced
subdirectory subdirectories subfolder subfolders
filesystem filesystems filepath filepaths filetype filetypes
codec codecs transcode transcoded transcoding
screenshot screenshots screencast screencasts
regexp regexps
urlsafe base64url
frontmatter
avatar avatars localstorage sessionstorage snackbar snackbars demo demos captcha recaptcha pubsub chatbot chatbots
mdx xlsx webm intl typeahead combobox datepicker timepicker colorpicker callout callouts esm ssg isr rsc lsp vdom
progressbar clipboard ips emoji emojis
`);

/** Words that need no grounding anywhere: function words, determiners, auxiliaries and the ordinary glue of English. */
const STOP_LIST = set(`
a an and are as at be but by can do does did for from has have had if in into is it its not of on or so than that the
then there these this those to was were when where which while who whom whose will with without would about after again all
also any back because been before being both each either else every few first just last like more most much must
never new next no none now off often once only other out over own per same should since some still such too under
until up upon very via what whether why yet am i me my he she we they them their theirs his her hers us our ours
you your yours one two three four five six seven eight nine ten zero
don't doesn't didn't isn't aren't wasn't weren't won't wouldn't can't cannot couldn't shouldn't hasn't haven't hadn't
it's that's there's here's let's
e.g i.e etc vs
`);

/** Ordinary contractions; apostrophes elsewhere are not accepted. */
const CONTRACTIONS = set(
  "don't doesn't didn't isn't aren't wasn't weren't won't wouldn't can't couldn't shouldn't hasn't haven't hadn't it's that's there's here's let's",
);
export function isContraction(t: string): boolean {
  return CONTRACTIONS.has(t.toLowerCase());
}

export function isStopWord(w: string): boolean {
  return STOP_LIST.has(w);
}

/** Prefixes that may be put in front of a word (reload, nonempty, subtree, multithreaded, autosave, ...). */
const PREFIXES = [
  "un",
  "re",
  "non",
  "pre",
  "de",
  "sub",
  "multi",
  "auto",
  "dis",
  "mis",
  "over",
  "under",
  "inter",
  "intra",
  "out",
  "semi",
  "anti",
  "cross",
  "self",
  "co",
  "mid",
  "hyper",
  "micro",
  "macro",
  "meta",
  "pseudo",
  "uni",
  "bi",
  "ex",
  "in",
  "im",
  "up",
  "down",
  "post",
];
/** Prefixes too short or too common to put in front of arbitrary letters: they need a base of five letters or more. */
const SHORT_PREFIXES = new Set(["in", "im", "ex", "bi", "uni", "co", "de", "up", "mid", "un", "re"]);

/** A base word: hand list or Bloom filter. Two-letter words come only from the hand list. */
export function isBaseWord(w: string): boolean {
  if (w.length < 2 || w.length > 20) return false;
  if (SHORT_WORDS.has(w) || TECH_WORDS.has(w) || TECH_MORE.has(w)) return true;
  return w.length >= 4 && inBloom(w);
}

/** Candidate stems of a regularly inflected or derived form (each at least three letters). */
export function stemsOf(w: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (s.length >= 3) out.push(s);
  };
  const dbl = (s: string) => {
    if (s.length >= 4 && s[s.length - 1] === s[s.length - 2]) add(s.slice(0, -1));
  };
  const n = w.length;
  if (w.endsWith("ies")) add(`${w.slice(0, -3)}y`);
  if (w.endsWith("ves")) {
    add(`${w.slice(0, -3)}f`);
    add(`${w.slice(0, -3)}fe`);
  }
  if (w.endsWith("es")) add(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) add(w.slice(0, -1));
  if (w.endsWith("ied")) add(`${w.slice(0, -3)}y`);
  if (w.endsWith("ed")) {
    add(w.slice(0, -2));
    add(w.slice(0, -1));
    dbl(w.slice(0, -2));
  }
  if (w.endsWith("ing")) {
    const s = w.slice(0, -3);
    add(s);
    add(`${s}e`);
    dbl(s);
    if (s.endsWith("y")) add(`${s.slice(0, -1)}ie`);
  }
  if (w.endsWith("ier")) add(`${w.slice(0, -3)}y`);
  if (w.endsWith("iest")) add(`${w.slice(0, -4)}y`);
  if (w.endsWith("er")) {
    add(w.slice(0, -2));
    add(w.slice(0, -1));
    dbl(w.slice(0, -2));
  }
  if (w.endsWith("ers")) {
    add(w.slice(0, -3));
    add(w.slice(0, -2));
    dbl(w.slice(0, -3));
  }
  if (w.endsWith("est")) {
    add(w.slice(0, -3));
    add(w.slice(0, -2));
    dbl(w.slice(0, -3));
  }
  if (w.endsWith("ily")) add(`${w.slice(0, -3)}y`);
  if (w.endsWith("ally")) add(w.slice(0, -4));
  if (w.endsWith("ly")) {
    add(w.slice(0, -2));
    add(`${w.slice(0, -2)}e`);
  }
  if (w.endsWith("able") || w.endsWith("ible")) {
    const s = w.slice(0, -4);
    add(s);
    add(`${s}e`);
    dbl(s);
    if (s.endsWith("i")) add(`${s.slice(0, -1)}y`);
  }
  if (w.endsWith("ably") || w.endsWith("ibly")) {
    add(w.slice(0, -4));
    add(`${w.slice(0, -4)}e`);
  }
  if (w.endsWith("ness")) {
    add(w.slice(0, -4));
    if (w.endsWith("iness")) add(`${w.slice(0, -5)}y`);
  }
  if (w.endsWith("ment")) {
    add(w.slice(0, -4));
    add(`${w.slice(0, -4)}e`);
  }
  if (w.endsWith("tion") || w.endsWith("sion")) {
    const s = w.slice(0, -3);
    add(s);
    add(`${s}e`);
    add(`${w.slice(0, -4)}te`);
  }
  if (w.endsWith("ation")) {
    add(`${w.slice(0, -5)}e`);
    add(w.slice(0, -5));
    add(`${w.slice(0, -5)}ate`);
  }
  if (w.endsWith("ity")) {
    add(w.slice(0, -3));
    add(`${w.slice(0, -3)}e`);
    add(`${w.slice(0, -3)}le`);
  }
  if (w.endsWith("ful") || w.endsWith("less")) add(w.slice(0, w.endsWith("ful") ? -3 : -4));
  if (w.endsWith("ize") || w.endsWith("ise")) add(w.slice(0, -3));
  if (w.endsWith("izer") || w.endsWith("iser")) add(w.slice(0, -4));
  if (w.endsWith("al") && n > 5) {
    add(w.slice(0, -2));
    add(`${w.slice(0, -2)}e`);
  }
  if (w.endsWith("or") && n > 5) {
    add(w.slice(0, -2));
    add(`${w.slice(0, -2)}e`);
  }
  if (w.endsWith("ive") && n > 6) add(`${w.slice(0, -3)}e`);
  if (w.endsWith("ant") && n > 6) add(w.slice(0, -3));
  if (w.endsWith("ence") || w.endsWith("ance")) add(w.slice(0, -4));
  return out;
}

/**
 * True when `w` (lower-case letters) is an ordinary word under `known`, a base-word test: a base word itself, a
 * regular derived form of one (up to two steps, "reconnections" = re + connect + ion + s) or a prefixed one.
 */
export function derivesFrom(w: string, known: (base: string) => boolean, depth = 2): boolean {
  if (known(w)) return true;
  if (depth === 0 || w.length < 4) return false;
  for (const s of stemsOf(w)) if (derivesFrom(s, known, depth - 1)) return true;
  for (const p of PREFIXES) {
    if (!w.startsWith(p)) continue;
    const rest = w.slice(p.length);
    if (rest.length < (SHORT_PREFIXES.has(p) ? 5 : 3)) continue;
    if (rest.length >= 3 && derivesFrom(rest, known, depth - 1)) return true;
  }
  return false;
}

const memo = new Map<string, boolean>();

/** True for an ordinary English or programming word (lower-case letters only), with inflection and prefix handling. */
export function isWord(w: string): boolean {
  if (!/^[a-z]+$/.test(w) || w.length > 24) return false;
  const hit = memo.get(w);
  if (hit !== undefined) return hit;
  const r = isBaseWord(w) || derivesFrom(w, isBaseWord);
  if (memo.size > 5000) memo.clear();
  memo.set(w, r);
  return r;
}

/** Size of the hand lists, for the report. */
export const HAND_LIST_COUNTS = { short: SHORT_WORDS.size, tech: TECH_WORDS.size + TECH_MORE.size };
