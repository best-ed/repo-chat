/**
 * What counts as indexable source, and how much of it we accept.
 * This is the file to edit when a repo gets skipped for the wrong reason.
 */

// The caps themselves live outside server/ so the UI can state the same numbers
// it will be judged against.
export { MAX_FILES, MAX_TOTAL_BYTES } from '../../../utils/repoLimits'

/** Extensions we treat as text worth indexing. Everything else is skipped. */
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  // web
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro',
  '.html', '.css', '.scss', '.sass', '.less',
  // backend / systems
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.scala', '.ex', '.exs', '.erl', '.clj',
  // shell / config / data
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini',
  '.sql', '.graphql', '.gql', '.proto',
  // docs
  '.md', '.mdx', '.rst', '.txt', '.adoc'
])

/** Extensionless files that are still worth reading. */
export const ALLOWED_FILENAMES: ReadonlySet<string> = new Set([
  'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Procfile', 'Justfile',
  'LICENSE', 'README', 'CHANGELOG', '.env.example'
])

/**
 * Lockfiles carry allowlisted extensions but are machine-generated noise —
 * they would blow the byte cap and answer no useful question.
 */
export const DENIED_FILENAMES: ReadonlySet<string> = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'bun.lock', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock',
  'composer.lock', 'Gemfile.lock', 'go.sum', 'flake.lock',
  'pubspec.lock', 'mix.lock', 'gradle.lockfile'
])

/** Directory names that are never worth descending into, at any depth. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', 'target', 'vendor', 'coverage',
  '.next', '.nuxt', '.output', '.turbo', '.cache', '.venv', 'venv',
  '__pycache__', '.pytest_cache', '.gradle', '.idea', '.vscode'
])

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot).toLowerCase()
}

/**
 * Decide whether a repo-relative path should be indexed. Paths arriving here
 * are already stripped of the tarball's root directory.
 */
export function isIndexablePath(relativePath: string): boolean {
  const segments = relativePath.split('/')
  const filename = segments[segments.length - 1]
  if (!filename) return false

  if (segments.slice(0, -1).some((segment) => SKIPPED_DIRECTORIES.has(segment))) return false
  if (DENIED_FILENAMES.has(filename)) return false

  // Dotfiles fall out naturally: `.eslintrc.json` matches on `.json`,
  // `.gitignore` has no allowlisted extension and is skipped.
  return ALLOWED_EXTENSIONS.has(extensionOf(filename)) || ALLOWED_FILENAMES.has(filename)
}
