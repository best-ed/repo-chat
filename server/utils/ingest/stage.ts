import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { extract } from 'tar-stream'

import { IngestError } from './github'
import { MAX_FILES, MAX_TOTAL_BYTES, isIndexablePath } from './limits'

export interface StagedFile {
  /** Repo-relative path, with the tarball's root directory stripped. */
  path: string
  bytes: number
}

export interface StagedRepo {
  /** Absolute path under the OS temp dir. The caller owns cleanup. */
  dir: string
  files: StagedFile[]
  fileCount: number
  byteCount: number
}

/**
 * Vercel's filesystem is read-only apart from the temp dir, so staging never
 * touches the working directory.
 */
export function createStagingDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'repo-chat-'))
}

export function removeStagingDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true })
}

/** GitHub tarballs wrap everything in a single `{owner}-{repo}-{sha}/` directory. */
function stripRootDirectory(entryPath: string): string {
  const separator = entryPath.indexOf('/')
  return separator === -1 ? '' : entryPath.slice(separator + 1)
}

/**
 * Streams a gzipped tarball into `dir`, keeping only indexable files.
 *
 * Limits are checked as each entry header arrives, so a repository that blows
 * the cap aborts the download instead of being measured after the fact. Callers
 * get an IngestError whose message is safe to show the user, and the job is
 * expected to fail — a repo over the limit is never partially staged and
 * reported as complete.
 */
export async function stageTarball(body: ReadableStream<Uint8Array>, dir: string): Promise<StagedRepo> {
  const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
  const archive = extract()
  const files: StagedFile[] = []
  let byteCount = 0

  // Kick the download off; the for-await below is what actually drains it.
  const pumped = pipeline(source, createGunzip(), archive)

  try {
    for await (const entry of archive) {
      const header = entry.header

      if (header.type !== 'file') {
        // Directories are implied by the files inside them. Symlinks and
        // hardlinks are skipped outright: following one could write outside dir.
        entry.resume()
        continue
      }

      const relativePath = stripRootDirectory(header.name)
      if (!relativePath || !isIndexablePath(relativePath)) {
        entry.resume()
        continue
      }

      const destination = path.resolve(dir, relativePath)
      if (destination !== dir && !destination.startsWith(dir + path.sep)) {
        // A `..` segment or absolute path trying to escape the staging dir.
        entry.resume()
        continue
      }

      const size = header.size ?? 0

      if (files.length + 1 > MAX_FILES) {
        throw new IngestError(`Repository exceeds the ${MAX_FILES}-file limit for indexable files.`)
      }
      if (byteCount + size > MAX_TOTAL_BYTES) {
        const limitMb = MAX_TOTAL_BYTES / (1024 * 1024)
        throw new IngestError(`Repository exceeds the ${limitMb} MB limit for indexable text.`)
      }

      await mkdir(path.dirname(destination), { recursive: true })
      await pipeline(entry, createWriteStream(destination))

      files.push({ path: relativePath, bytes: size })
      byteCount += size
    }

    await pumped
  } catch (error) {
    // Stop the transfer rather than letting the rest of the archive download.
    source.destroy()
    archive.destroy()
    throw error
  }

  return { dir, files, fileCount: files.length, byteCount }
}
