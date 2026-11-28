Closes #

## What changed

<!-- A short summary of the change and why. -->

## How I checked it

<!-- Commands you ran, views you looked at, fixtures you used. -->

## Checklist

- [ ] `pnpm check` passes locally (there is no CI service)
- [ ] If the PR touches the explorer: `pnpm build && pnpm --filter @gantry/explorer e2e` reports 0 failed
- [ ] Follows `docs/SPEC.md`, or the spec is updated in this PR and the change is called out above
- [ ] No code, descriptions, graph dumps or screenshots from a private repository
- [ ] New dependencies, if any, are listed in spec section 2
- [ ] `README.md` updated if user-visible behavior, commands or views changed (and `pnpm readme:media` re-run if a view's look changed)
