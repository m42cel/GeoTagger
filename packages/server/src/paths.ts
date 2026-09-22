import path from 'node:path';
import fs from 'node:fs';

export class PathConfinementError extends Error {
  constructor(requested: string) {
    super(`Path escapes the configured photo root: ${requested}`);
    this.name = 'PathConfinementError';
  }
}

/**
 * Resolves a client-supplied relative path against the photo root and rejects
 * anything that lands outside it (SPEC §11 "Path confinement").
 *
 * Symlinks are followed with realpath so a link pointing out of the root is caught
 * too. A path that does not exist yet is checked against its nearest existing
 * ancestor, which is what lets `.geotagger/` be created inside a folder.
 *
 * This is bug containment, not access control.
 */
export function resolveWithinRoot(root: string, relPath: string): string {
  if (relPath.includes('\0')) throw new PathConfinementError(relPath);
  const candidate = path.resolve(root, relPath);
  const real = realpathOfNearestExisting(candidate);
  const realRoot = fs.realpathSync(root);
  if (!isBeneath(realRoot, real)) throw new PathConfinementError(relPath);
  return candidate;
}

/** True when `child` is `parent` itself or lies beneath it. */
export function isBeneath(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * realpath of `p`, or of the deepest ancestor of `p` that exists. Used so that a
 * not-yet-created path is still validated against a resolved, real location.
 */
function realpathOfNearestExisting(p: string): string {
  let current = p;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Path of a folder relative to the root, using forward slashes; '' for the root. */
export function toRelPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join('/');
}
