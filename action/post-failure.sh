#!/usr/bin/env bash
# Posts the "analysis failed" comment of the Action (issue #282) when the install failed, so the release tarball and
# its dist/action.js are not there. It needs only bash, curl and node (which action.yml sets up before anything else).
# It builds the same text as buildFailureComment in src/comment.ts (a test keeps the two equal), updates the earlier
# Gantry comment in place when there is one, and otherwise creates it. When no comment can be posted (a pull request
# from a fork, a refused token, no network) the text goes to the job summary. It always exits 0: it is the fail-open path.
#
# Environment: GANTRY_FAILURE (why), GANTRY_TOKEN, GITHUB_REPOSITORY, GANTRY_PR (pull request number, empty when the
# run is not for a pull request), GANTRY_FORK ("true" for a pull request from a fork), GITHUB_API_URL (default
# https://api.github.com), GITHUB_STEP_SUMMARY and GITHUB_OUTPUT when set.
set -u

marker='<!-- gantry:pr-comment -->'
# One bounded line: only plain characters survive, so the text needs no JSON or Markdown escaping.
reason=$(printf '%s' "${GANTRY_FAILURE:-the install failed}" | tr -c 'A-Za-z0-9 ._:,;()/=@+-' ' ' | tr -s ' ' | cut -c1-200)
reason=${reason# }
reason=${reason% }
[ -n "$reason" ] || reason='-'
body=$(printf '%s\n## Gantry: the analysis failed\n\nGantry could not analyze this pull request: `%s`\n\n<sub>The pull request itself is not affected. The job log of the Gantry step has the details.</sub>\n' "$marker" "$reason")
body="$body"$'\n'

finish() {
  # $1 is created, updated or summary; $2 the comment's link
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf 'comment=%s\ncomment-url=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; fi
  echo "gantry-action: $1"
  exit 0
}
summary() {
  echo "::notice title=Gantry::No comment posted ($1). The failure notice is in the job summary."
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$body" >> "$GITHUB_STEP_SUMMARY"; fi
  finish summary ""
}

echo "::warning title=Gantry::The analysis failed: $reason"

if [ -z "${GANTRY_PR:-}" ]; then summary "this run is not for a pull request"; fi
if [ "${GANTRY_FORK:-}" = "true" ]; then summary "pull request from a fork: its token cannot comment"; fi
if [ -z "${GANTRY_TOKEN:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ]; then summary "no github-token or repository to comment with"; fi

api=${GITHUB_API_URL:-https://api.github.com}
api=${api%/}
json=$(printf '{"body":"%s"}' "$(printf '%s' "$body" | awk 'BEGIN { ORS = "\\n" } { print }')")
call() { # method url [data]: prints the response body, then the status code on its own line
  local method=$1 url=$2
  shift 2
  curl -sS --max-time 30 -X "$method" -H "Authorization: Bearer $GANTRY_TOKEN" -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" -H "User-Agent: gantry-action" "$@" -w '\n%{http_code}' "$url" 2>/dev/null
}

# The first comment whose body starts with the marker, over at most 50 pages of 100.
id=""
page=1
while [ "$page" -le 50 ]; do
  res=$(call GET "$api/repos/$GITHUB_REPOSITORY/issues/$GANTRY_PR/comments?per_page=100&page=$page") || summary "the GitHub API could not be reached"
  code=${res##*$'\n'}
  data=${res%$'\n'*}
  case "$code" in 2??) ;; *) summary "the token cannot comment (HTTP $code)" ;; esac
  found=$(printf '%s' "$data" | GANTRY_MARKER="$marker" node -e '
    let s = ""; process.stdin.on("data", (c) => { s += c; }).on("end", () => {
      const list = JSON.parse(s);
      const hit = list.find((c) => typeof c.body === "string" && c.body.startsWith(process.env.GANTRY_MARKER));
      console.log(JSON.stringify({ id: hit ? hit.id : "", last: list.length === 0 }));
    });' 2>/dev/null) || summary "the comment list could not be read"
  id=$(printf '%s' "$found" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  if [ -n "$id" ] || printf '%s' "$found" | grep -q '"last":true'; then break; fi
  page=$((page + 1))
done

post() { # method url
  res=$(call "$1" "$2" -H "Content-Type: application/json" --data "$json") || return 1
  code=${res##*$'\n'}
  data=${res%$'\n'*}
  case "$code" in 2??) ;; *) return 1 ;; esac
  link=$(printf '%s' "$data" | sed -n 's/.*"html_url":"\([^"]*\)".*/\1/p' | head -n 1)
  return 0
}

link=""
if [ -n "$id" ] && post PATCH "$api/repos/$GITHUB_REPOSITORY/issues/comments/$id"; then finish updated "$link"; fi
if post POST "$api/repos/$GITHUB_REPOSITORY/issues/$GANTRY_PR/comments"; then finish created "$link"; fi
summary "the token cannot comment"
