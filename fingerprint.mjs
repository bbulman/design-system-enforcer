/**
 * The fingerprint a confirmation's key ends with. It lives apart from confirm.mjs, which loads the
 * MCP SDK, because report.mjs needs it too and the command line's apply runs without the SDK.
 */
import { createHash } from 'node:crypto';

/** The first 12 hex characters of the SHA-256 of the parts, one per line. */
export function fingerprint(...parts) {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);
}
