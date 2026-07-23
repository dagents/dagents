import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { createLogger } from '@mil/shared'
import { sha256Bytes } from './hash.js'

/**
 * Artifact object store backed by MinIO (S3-compatible), plan M4.1 / P1.8.T4.
 *
 * `archiveArtifact` PUTs an artifact's bytes under a content-addressed key
 * (`runs/<runId>/<sha256>`) and returns the S3 URI it was stored under, which
 * the caller writes back into `runs.artifact_uri`. Content-addressing means a
 * re-archive of identical bytes reuses the same key (PutObject overwrites, so
 * it stays idempotent), and the sha is part of the path so a reader can verify
 * integrity without an extra HEAD.
 *
 * The store is injected as an interface (`ArtifactStore`) so tests can swap in
 * an in-memory stub without a live MinIO — same seam the scheduler's
 * `PredictionClient` uses. The production impl (`createS3ArtifactStore`) wires
 * the real `@aws-sdk/client-s3` client with path-style addressing (MinIO needs
 * `forcePathStyle`).
 */

const log = createLogger({ svc: 'repro:artifact' })

/**
 * A reproducible artifact — one run's output blob to archive (spec §1.8
 * `RunArtifact`). `bytes` is the opaque content; `contentType` is recorded so
 * a reader can render it; `filename` is a human hint folded into the object
 * key but not used for addressing (the sha is).
 */
export interface RunArtifact {
  bytes: Uint8Array
  contentType?: string
  filename?: string
}

export interface PutResult {
  /** The S3 URI the artifact was stored under — written to `runs.artifact_uri`. */
  uri: string
  /** The bucket the object landed in. */
  bucket: string
  /** The object key (content-addressed: `runs/<runId>/<sha256>`). */
  key: string
  /** SHA-256 hex of the artifact bytes (content address). */
  sha256: string
}

export interface ArtifactStore {
  put(runId: string, artifact: RunArtifact): Promise<PutResult>
  get(uri: string): Promise<RunArtifact>
}

export interface S3ArtifactStoreOpts {
  endpoint: string
  region?: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** Force path-style addressing (MinIO requires true; AWS S3 uses false). */
  forcePathStyle?: boolean
}

/**
 * Parse an `s3://` URI into `{ bucket, key }`. Used by `get()` to resolve a
 * stored artifact URI back to the object. Throws on a non-s3 URI so a bad
 * `runs.artifact_uri` fails loudly rather than silently fetching nothing.
 */
export function parseS3Uri(uri: string): { bucket: string; key: string } {
  const m = uri.match(/^s3:\/\/([^/]+)\/(.+)$/)
  if (!m) throw new Error(`invalid s3 uri: ${uri}`)
  return { bucket: m[1], key: m[2] }
}

/** Build the `s3://<bucket>/<key>` URI from parts. */
export function s3Uri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`
}

/** Sanitize a filename into a path-safe segment (drop path separators). */
function safeFilename(name: string | undefined): string | undefined {
  if (!name) return undefined
  const clean = name.replace(/[^A-Za-z0-9._-]+/g, '_')
  return clean.length > 0 ? clean.slice(0, 128) : undefined
}

/**
 * Production artifact store: PUTs/GETs against MinIO (or any S3-compatible
 * store) via `@aws-sdk/client-s3`. The client is created lazily so constructing
 * the store (e.g. at module load in tests) does not require MinIO to be up.
 */
export function createS3ArtifactStore(opts: S3ArtifactStoreOpts): ArtifactStore {
  const clientConfig: S3ClientConfig = {
    endpoint: opts.endpoint,
    region: opts.region ?? 'us-east-1',
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    forcePathStyle: opts.forcePathStyle ?? true,
  }
  let client: S3Client | null = null
  const getClient = (): S3Client => {
    if (!client) client = new S3Client(clientConfig)
    return client
  }

  return {
    put: async (runId, artifact) => {
      const sha = sha256Bytes(artifact.bytes)
      const parts = ['runs', runId, sha]
      const fname = safeFilename(artifact.filename)
      if (fname) parts.push(fname)
      const key = parts.join('/')
      const uri = s3Uri(opts.bucket, key)

      try {
        await getClient().send(
          new PutObjectCommand({
            Bucket: opts.bucket,
            Key: key,
            Body: artifact.bytes,
            ContentType: artifact.contentType ?? 'application/octet-stream',
          }),
        )
      } catch (err) {
        // MinIO unreachable / credentials wrong / bucket missing. Surface a
        // structured error so `archiveArtifact` can fail the run rather than
        // silently dropping the artifact.
        log.error('s3 put failed', { runId, key, error: String(err) })
        throw new Error(`s3 put failed for ${runId}: ${String(err)}`)
      }

      return { uri, bucket: opts.bucket, key, sha256: sha }
    },

    get: async (uri) => {
      const { bucket, key } = parseS3Uri(uri)
      try {
        const resp = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        const body = resp.Body
        if (!body) throw new Error(`s3 get returned empty body: ${uri}`)
        // S3 Body is a SdkStreamMixin with `.transformToByteArray()`.
        const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
        return {
          bytes,
          contentType: resp.ContentType,
        }
      } catch (err) {
        log.error('s3 get failed', { uri, error: String(err) })
        throw new Error(`s3 get failed for ${uri}: ${String(err)}`)
      }
    },
  }
}
