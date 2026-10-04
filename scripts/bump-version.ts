/**
 * Sets one version on the root and both published packages.
 * Usage: vp run bump <patch|minor|major|x.y.z>
 */
import { readFileSync, writeFileSync } from 'node:fs'

type Manifest = { version: string }

const MANIFESTS = [
  '../package.json',
  '../packages/effect-slotdb/package.json',
  '../packages/effect-slotdb-sqlite/package.json',
].map(path => new URL(path, import.meta.url))
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const main = (arg: string | undefined): void => {
  const manifests = MANIFESTS.map(path => ({ path, json: readManifest(path) }))
  const current = new Set(manifests.map(m => m.json.version))
  if (current.size !== 1) fail(`The manifests disagree on the version: ${[...current].join(', ')}`)
  const next = nextVersion([...current][0], arg)
  for (const { path, json } of manifests) {
    writeFileSync(path, `${JSON.stringify({ ...json, version: next }, null, 2)}\n`)
  }
  console.log(`Set version ${next}. Commit, tag, and push:

  git commit -am 'chore(release): v${next}'
  git tag -a v${next} -m 'Release notes'    # each -m adds a paragraph to the GitHub release
  git push --follow-tags`)
}

const readManifest = (path: URL): Manifest => JSON.parse(readFileSync(path, 'utf8'))

const nextVersion = (current: string, arg: string | undefined): string => {
  const [major, minor, patch] = current.split(/[.-]/).map(Number)
  switch (arg) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
    default:
      if (arg && SEMVER.test(arg)) return arg
      return fail('Usage: vp run bump <patch|minor|major|x.y.z>')
  }
}

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

main(process.argv[2])
