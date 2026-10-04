# Releasing

Both packages use the same version and require Effect `4.0.0`. Keep the workspace catalog and published peer dependencies aligned.

The release workflow stages both packages on npm when you push a `v*` tag. To release a version:

```bash
vp run bump minor        # or patch, major, or a version such as 0.3.0-beta.1
git commit -am 'chore(release): v0.2.0'
git tag -a v0.2.0 -m 'Release notes'   # each -m adds a paragraph to the release notes
git push --follow-tags
# after the workflow finishes:
pnpm stage approve       # pick @tachuris/effect-slotdb first, then the SQLite package
```

The workflow runs the CI checks and confirms that the tag matches both package versions. Then it builds the packages, stages them on npm, and creates a GitHub release from the tag message. A staged version stays invisible to installs until you approve it with 2FA, through `pnpm stage approve` or on the package page at npmjs.com. A version with a prerelease suffix publishes under the `next` dist tag. pnpm stages `@tachuris/effect-slotdb` before `@tachuris/effect-slotdb-sqlite` and skips any version that npm already has, so a failed workflow can run again.

To test the packed tarballs locally, run `vp run build`, then `vp run check:consumer`. The script installs both tarballs into a clean project, typechecks every entry point, and loads all entry points except `./bun` in Node.

## npm setup

npm accepts a trusted publisher only for a package that already exists. Before the first release from CI:

1. Create the `tachuris` organization on npmjs.com, so that the `@tachuris` scope exists.
2. Publish the first version from your machine: `npm login`, `vp run build`, then `vp pm publish -r`.
3. On npmjs.com, open the settings of each package and add a GitHub Actions trusted publisher with organization `tachuris`, repository `effect-slotdb`, workflow `release.yml`, and environment `npm`. Leave both allowed actions unchecked, so the workflow can only stage.
4. In the same settings, require two-factor authentication and disallow tokens for publishing.

npm generates provenance attestations only for packages published from a public repository.

## Dependencies

`effect` and `@tachuris/effect-slotdb` are peer dependencies. Consumers provide the required copies. `@effect/sql-sqlite-bun` is an optional peer for `./bun`. `wa-sqlite` installs from GitHub to provide the OPFS VFS used by the browser driver.
