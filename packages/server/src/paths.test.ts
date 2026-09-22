import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isBeneath, PathConfinementError, resolveWithinRoot, toRelPath } from './paths.js';

let root: string;
let outside: string;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-paths-'));
  fs.mkdirSync(path.join(base, 'photos', 'Italy2025', 'PersonA'), { recursive: true });
  root = fs.realpathSync(path.join(base, 'photos'));
  outside = fs.realpathSync(base);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
});

afterAll(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('resolveWithinRoot — SPEC §11 path confinement', () => {
  it('accepts the root itself and paths beneath it', () => {
    expect(resolveWithinRoot(root, '')).toBe(root);
    expect(resolveWithinRoot(root, 'Italy2025')).toBe(path.join(root, 'Italy2025'));
    expect(resolveWithinRoot(root, 'Italy2025/PersonA')).toBe(path.join(root, 'Italy2025', 'PersonA'));
  });

  it('accepts a path that does not exist yet, so .geotagger/ can be created', () => {
    expect(resolveWithinRoot(root, 'Italy2025/.geotagger/edits.sqlite')).toBe(
      path.join(root, 'Italy2025', '.geotagger', 'edits.sqlite'),
    );
  });

  it('rejects traversal out of the root', () => {
    expect(() => resolveWithinRoot(root, '..')).toThrow(PathConfinementError);
    expect(() => resolveWithinRoot(root, '../secret.txt')).toThrow(PathConfinementError);
    expect(() => resolveWithinRoot(root, 'Italy2025/../../secret.txt')).toThrow(PathConfinementError);
    expect(() => resolveWithinRoot(root, 'Italy2025/../..')).toThrow(PathConfinementError);
  });

  it('rejects an absolute path outside the root', () => {
    expect(() => resolveWithinRoot(root, outside)).toThrow(PathConfinementError);
    expect(() => resolveWithinRoot(root, '/etc/passwd')).toThrow(PathConfinementError);
  });

  it('rejects a symlink pointing out of the root', () => {
    const link = path.join(root, 'escape');
    fs.symlinkSync(outside, link);
    try {
      expect(() => resolveWithinRoot(root, 'escape')).toThrow(PathConfinementError);
      expect(() => resolveWithinRoot(root, 'escape/secret.txt')).toThrow(PathConfinementError);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('rejects a null byte', () => {
    expect(() => resolveWithinRoot(root, 'Italy2025\0.jpg')).toThrow(PathConfinementError);
  });

  it('does not reject a sibling whose name merely starts with the root name', () => {
    const sibling = `${root}-other`;
    fs.mkdirSync(sibling, { recursive: true });
    try {
      expect(() => resolveWithinRoot(root, sibling)).toThrow(PathConfinementError);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe('isBeneath', () => {
  it('treats a path as beneath itself', () => {
    expect(isBeneath('/a/b', '/a/b')).toBe(true);
  });
  it('does not confuse a prefix match with containment', () => {
    expect(isBeneath('/a/b', '/a/bc')).toBe(false);
    expect(isBeneath('/a/b', '/a/b/c')).toBe(true);
  });
});

describe('toRelPath', () => {
  it('returns an empty string for the root and forward slashes beneath it', () => {
    expect(toRelPath('/photos', '/photos')).toBe('');
    expect(toRelPath('/photos', '/photos/Italy2025/PersonA')).toBe('Italy2025/PersonA');
  });
});
