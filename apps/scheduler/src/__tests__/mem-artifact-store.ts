import { sha256Bytes, type ArtifactStore, type PutResult, type RunArtifact } from '@dagents/repro'

/**
 * In-memory `ArtifactStore` for scheduler tests (M4.3 reproduce).
 *
 * The repro package's own suite already exercises the real MinIO-backed store
 * against the docker-compose stack; the scheduler reproduce test wants to
 * assert the *wiring* (report archived → `runs.artifact_uri` set; round-trip
 * via `get`) without taking a hard MinIO dependency in a second suite. This
 * stub mirrors `createS3ArtifactStore`'s contract — `put` returns a
 * content-addressed `s3://` URI (so the URI shape assertion still holds), and
 * `get` returns the exact bytes `put` stored.
 *
 * Keyed by URI so `get(uri)` is O(1) and independent of insertion order.
 */

export function createMemoryArtifactStore(): ArtifactStore & {
  /** All objects ever PUT, keyed by URI — exposed for test assertions. */
  readonly objects: ReadonlyMap<string, RunArtifact>
} {
  const objects = new Map<string, RunArtifact>()

  return {
    objects,
    put: async (runId, artifact): Promise<PutResult> => {
      // Mirror the production key shape so URI assertions are meaningful:
      // runs/<runId>/<sha256>[/<filename>]. The sha is the content address.
      const sha = sha256Bytes(artifact.bytes)
      const parts = ['runs', runId, sha]
      if (artifact.filename) parts.push(artifact.filename)
      const key = parts.join('/')
      const uri = `s3://test-bucket/${key}`
      objects.set(uri, artifact)
      return { uri, bucket: 'test-bucket', key, sha256: sha }
    },
    get: async (uri): Promise<RunArtifact> => {
      const obj = objects.get(uri)
      if (!obj) throw new Error(`memory store: no object at ${uri}`)
      return obj
    },
  }
}

/**
 * A store whose `put` always rejects — used to assert the reproduce route
 * degrades gracefully when archiving fails (M4.3 review MEDIUM#3): the
 * already-computed match/diff verdict must still return 200 with
 * `artifactUri=null`, not 502.
 */
export function createThrowingArtifactStore(message = 'minio down'): ArtifactStore {
  return {
    put: async () => {
      throw new Error(message)
    },
    get: async () => {
      throw new Error(message)
    },
  }
}
