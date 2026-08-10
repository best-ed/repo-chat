/**
 * GitHub access for ingestion. Everything goes through the REST API over HTTPS —
 * no git binary, no child process, nothing that needs a writable cwd.
 */

const API_ROOT = 'https://api.github.com'
const USER_AGENT = 'repo-chat'

export interface RepoRef {
  owner: string
  name: string
  /** Canonical https URL, used as the unique key on Repo. */
  url: string
}

export interface ResolvedRepo extends RepoRef {
  defaultBranch: string
  /** Full 40-character commit SHA the tarball will be pinned to. */
  commitSha: string
  /** Repo size as GitHub reports it, in KB. */
  sizeKb: number
}

/** Raised with a message intended to be shown to the user via Job.error. */
export class IngestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IngestError'
  }
}

/**
 * Accepts the shapes people actually paste: with or without protocol, a
 * trailing slash, a trailing `.git`, or a `/tree/<branch>` suffix.
 */
export function parseRepoUrl(input: string): RepoRef {
  const trimmed = input.trim()
  if (!trimmed) throw new IngestError('No repository URL provided.')

  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    throw new IngestError(`"${input}" is not a valid URL.`)
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== 'github.com') {
    throw new IngestError(`Only github.com repositories are supported, got "${url.hostname}".`)
  }

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2) {
    throw new IngestError('URL must include an owner and a repository, e.g. https://github.com/owner/repo.')
  }

  const owner = segments[0]!
  const name = segments[1]!.replace(/\.git$/i, '')
  if (!owner || !name) {
    throw new IngestError('URL must include an owner and a repository, e.g. https://github.com/owner/repo.')
  }

  return { owner, name, url: `https://github.com/${owner}/${name}` }
}

function headers(): Record<string, string> {
  const base: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
    'x-github-api-version': '2022-11-28'
  }
  // Unauthenticated access is capped at 60 requests/hour; a token raises it to
  // 5000. Ingestion spends three calls per repo, so this matters quickly.
  const token = process.env.GITHUB_TOKEN
  if (token) base.authorization = `Bearer ${token}`
  return base
}

async function failureFor(response: Response, context: string): Promise<IngestError> {
  if (response.status === 404) {
    return new IngestError('Repository not found. It may be private, renamed, or misspelled.')
  }
  if (response.status === 403 || response.status === 429) {
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      const token = process.env.GITHUB_TOKEN
      return new IngestError(
        token
          ? 'GitHub API rate limit exhausted for this token. Try again later.'
          : 'GitHub API rate limit exhausted (60 requests/hour unauthenticated). Set GITHUB_TOKEN to raise it to 5000.'
      )
    }
    return new IngestError('GitHub denied the request. The repository may be private.')
  }
  return new IngestError(`GitHub returned ${response.status} while ${context}.`)
}

/**
 * Resolves the repository to an exact commit. The tarball is then fetched at
 * that SHA, so what we record in Repo.commitSha is guaranteed to be what we
 * actually extracted — the tarball redirect itself only names a branch ref.
 */
export async function resolveRepo(ref: RepoRef): Promise<ResolvedRepo> {
  const metaResponse = await fetch(`${API_ROOT}/repos/${ref.owner}/${ref.name}`, { headers: headers() })
  if (!metaResponse.ok) throw await failureFor(metaResponse, 'looking up the repository')

  const meta = await metaResponse.json() as { default_branch?: string, size?: number, private?: boolean }
  if (meta.private) throw new IngestError('Only public repositories can be indexed.')

  const defaultBranch = meta.default_branch
  if (!defaultBranch) throw new IngestError('Repository has no default branch — it may be empty.')

  const commitResponse = await fetch(
    `${API_ROOT}/repos/${ref.owner}/${ref.name}/commits/${encodeURIComponent(defaultBranch)}`,
    { headers: headers() }
  )
  if (!commitResponse.ok) throw await failureFor(commitResponse, 'resolving the head commit')

  const commit = await commitResponse.json() as { sha?: string }
  if (!commit.sha) throw new IngestError('Could not resolve a commit for the default branch.')

  return { ...ref, defaultBranch, commitSha: commit.sha, sizeKb: meta.size ?? 0 }
}

/** Opens the tarball for a specific commit as a readable byte stream. */
export async function openTarball(repo: ResolvedRepo): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(
    `${API_ROOT}/repos/${repo.owner}/${repo.name}/tarball/${repo.commitSha}`,
    { headers: headers() }
  )
  if (!response.ok) throw await failureFor(response, 'downloading the repository archive')
  if (!response.body) throw new IngestError('GitHub returned an empty archive response.')
  return response.body
}
