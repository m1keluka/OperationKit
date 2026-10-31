#!/usr/bin/env python3
"""test-integrity.py — the gate's "no narrowed suite" check.

USAGE: scripts/test-integrity.py BASE_SHA HEAD_SHA   (run from the repo root)
EXIT:  0 clean; 1 on a violation; any git failure aborts non-zero.

Both rules read the PR's own changes: the diff from the merge-base of
BASE_SHA and HEAD_SHA to HEAD_SHA, so work landed on the base branch after
the PR branched is never attributed to the PR.

Two rules:

1. No new test skips. An added line in a test file must not introduce
   `.skip(`, `.only(`, `xit(` or `xdescribe(`.

2. No deleted test files — with ONE exception. A deleted test file is allowed
   only when the code it tests is deleted in the same diff, proven by either:

   a. NAME MATCH: a source file with the test's stem is deleted next to it.
      `foo.test.ts` -> `foo.ts|tsx|js|jsx|mts|cts`; dotted qualifiers are
      stripped one at a time, so `List.withName.test.tsx` also matches `List.tsx`.
   b. IMPORT MATCH: every relative module the test imports (`import ... from`,
      `import '...'`, `import(...)`, `require(...)`, `export ... from`) resolves
      to a file deleted in this diff, and there is at least one such import.
      `vi.mock(...)`/`jest.mock(...)` paths are stand-ins, not the code under
      test, so they are neither required nor counted.

   Fail-closed: a moved/renamed source is NOT a deletion (rename detection is
   forced on), a test file must not itself be the matched source, and an
   import that cannot be resolved against the base tree is treated as kept.
   Every allowed deletion is printed with its reason.

Every command's exit code is load-bearing: no error suppression and no
tolerated-failure idioms. If git itself fails (e.g. an unreachable base sha)
the script fails and the gate goes red. Fail closed, never fail quiet.
"""
import posixpath
import re
import subprocess
import sys

TESTS = ['*.test.ts', '*.test.tsx', '*.spec.ts', '*.spec.tsx']
TEST_RE = re.compile(r'\.(test|spec)\.(ts|tsx)$')
SRC_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']
NARROWING = re.compile(r'\.skip\(|\.only\(|\bxit\(|\bxdescribe\(')
# Relative specifiers only: package imports (react, vitest, ...) are not the
# code under test and are never deleted by a PR.
IMPORT_RE = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)"""
    r"""['"](\.{1,2}/[^'"]+)['"]""")


def git(*args):
    # check=True: a git failure fails the job rather than reading as "clean".
    return subprocess.run(['git', *args], check=True,
                          capture_output=True, text=True).stdout


def resolve(spec, from_dir, tree):
    """Map an import specifier to a file in `tree`, or None if unresolvable."""
    p = posixpath.normpath(posixpath.join(from_dir, spec))
    stem, ext = posixpath.splitext(p)
    cands = [p]
    # ESM TypeScript imports name the emitted file: `./x.js` is `./x.ts`.
    if ext in ('.js', '.jsx', '.mjs', '.cjs'):
        cands += [stem + e for e in SRC_EXTS]
    cands += [p + e for e in SRC_EXTS]
    cands += [p + '/index' + e for e in SRC_EXTS]
    for c in cands:
        if c in tree:
            return c
    return None


def name_match(test, deleted_src):
    d, base = posixpath.split(test)
    stem = TEST_RE.sub('', base)
    parts = stem.split('.')
    while parts:
        for e in SRC_EXTS:
            cand = posixpath.join(d, '.'.join(parts) + e)
            if cand in deleted_src:
                return cand
        parts.pop()
    return None


def import_match(test, base, deleted_src, base_tree):
    """Return (ok, detail). ok only if >=1 relative import and all deleted."""
    text = git('show', f'{base}:{test}')
    specs = sorted(set(IMPORT_RE.findall(text)))
    if not specs:
        return False, 'imports no relative module'
    d = posixpath.dirname(test)
    hits, kept = [], []
    for s in specs:
        r = resolve(s, d, base_tree)
        if r is not None and r in deleted_src:
            hits.append(r)
        else:
            kept.append(s if r is None else r)
    if kept:
        return False, 'still imports kept/unresolved module(s): ' + ', '.join(kept)
    return True, 'every import is deleted: ' + ', '.join(hits)


def main():
    if len(sys.argv) != 3:
        sys.exit('usage: test-integrity.py BASE_SHA HEAD_SHA')
    base_tip, head = sys.argv[1], sys.argv[2]
    # Diff from the fork point, not the base branch's current tip: a test added
    # to the base branch after this branch was cut is not "deleted" by this PR.
    # This is the same diff the PR's "Files changed" tab shows.
    base = git('merge-base', base_tip, head).strip()
    print(f'diffing {base}..{head} (merge-base of {base_tip} and {head})')
    fail = 0

    added = [l for l in git('diff', base, head, '--', *TESTS).splitlines()
             if l.startswith('+') and not l.startswith('+++')]
    hits = [l for l in added if NARROWING.search(l)]
    if hits:
        for l in hits:
            print(f'  {l}')
        print('::error title=New test skip/only introduced::'
              'A gated suite must not be narrowed to obtain a green.')
        fail = 1

    deleted = git('diff', '--diff-filter=D', '--name-only',
                  base, head, '--', *TESTS).split()
    rejected = []
    if deleted:
        # -M forces rename detection on regardless of local git config, so a
        # source file that was MOVED is not mistaken for code that was removed.
        deleted_src = {f for f in git('diff', '-M', '--diff-filter=D',
                                      '--name-only', base, head).split()
                       if not TEST_RE.search(f)}
        base_tree = set(git('ls-tree', '-r', '--name-only', base).split())
        for t in deleted:
            src = name_match(t, deleted_src)
            if src:
                print(f'ALLOWED deleted test {t}: its source {src} is deleted too')
                continue
            ok, detail = import_match(t, base, deleted_src, base_tree)
            if ok:
                print(f'ALLOWED deleted test {t}: {detail}')
                continue
            print(f'REJECTED deleted test {t}: no same-name source deleted; {detail}')
            rejected.append(t)
    if rejected:
        print('::error title=Test file deleted::' + ', '.join(rejected))
        fail = 1

    if not fail:
        print('OK: no new skips, no unjustified test deletions')
    sys.exit(fail)


if __name__ == '__main__':
    main()
