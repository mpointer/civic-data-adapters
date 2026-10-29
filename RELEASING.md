# Releasing

A release is a version bump merged to `main`, then a `v*` tag on the merge commit. Pushing the tag
runs `.github/workflows/release.yml`, which publishes to npm with provenance.

## Steps

1. Open a PR that bumps `package.json` and `package-lock.json`, the `DEFAULT_USER_AGENT` in
   `src/internal.ts` (a test pins it to `package.json`), and adds the version's section to
   `CHANGELOG.md`. Merge it.
2. Tag the merge commit and push the tag:
   ```
   git fetch origin
   git tag vX.Y.Z <merge commit sha>
   git push origin vX.Y.Z
   ```
3. If the `npm-publish` environment requires approval (below), approve the run in the Actions tab.
4. Check `npm view civic-data-adapters version`. The registry can lag a few minutes.

The workflow refuses to publish when the tag's commit is not an ancestor of `main`, when the tag does not
match `package.json`, or when typecheck, tests or build fail. A failed run publishes nothing; delete the tag,
fix, and push it again on the corrected commit.

## One-time setup: require approval to publish

The workflow's job declares `environment: npm-publish`. GitHub creates that environment the first time the
job runs, with no protection rules, so out of the box nothing waits. To make a publish need a human:

1. Repository **Settings > Environments > npm-publish**.
2. **Required reviewers**: add yourself (and anyone else who may approve). Anyone who can push a tag can
   start the run, but nothing reaches npm until a listed reviewer approves it.
3. **Deployment branches and tags**: choose *Selected branches and tags* and add the tag pattern `v*`, so
   only version tags can use the environment.
4. Leave **Prevent self-review** off if you are the only maintainer; otherwise you could not approve your
   own release.

## npm side

The package must list this repository's `release.yml` as a trusted publisher
(npmjs.com > package > Settings > Trusted Publisher). If you fill in the optional *Environment name* field
there, it must be exactly `npm-publish`; leaving it blank accepts any environment. Setting it to
`npm-publish` ties publishing to the approval gate: a run that does not go through that environment is
rejected by npm.
