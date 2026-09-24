import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
const BIN_DIR = path.join(REPOSITORY_ROOT, 'node_modules', '.bin');
const THIS_FILE = path.join(REPOSITORY_ROOT, 'scripts', 'lefthook-branch-guard.test.ts');
const ISOLATION_CHILD = 'LEFTHOOK_BRANCH_GUARD_ISOLATION_CHILD';

// Real pushes through the real lefthook.yml into a throwaway bare remote: this
// proves the pre-push branch-guard wiring itself, not just git-guard.sh (which
// scripts/test-git-guard.sh covers by piping refspec lines in directly). Only
// lefthook.yml and scripts/git-guard.sh are copied, so the guard must work
// without any lefthook source_dir scripts.
let root = '';
let work = '';
let gitEnv: NodeJS.ProcessEnv = {};

/**
 * Git exports GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and friends to hooks, and
 * this suite runs inside the pre-push hook via `pnpm test:scripts`. Inheriting
 * them would aim every git command here at the host repository instead of the
 * throwaway one, so child environments are built from an allowlist.
 */
function isolatedEnv(globalConfig: string): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
    // The developer's own git config (signing, a global hooksPath) must not
    // leak into the throwaway repository either.
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'lefthook test',
    GIT_AUTHOR_EMAIL: 'lefthook-test@example.invalid',
    GIT_COMMITTER_NAME: 'lefthook test',
    GIT_COMMITTER_EMAIL: 'lefthook-test@example.invalid',
    // The checklist command runs the whole monorepo gate; only the guard is
    // under test here.
    LEFTHOOK_EXCLUDE: 'checklist',
  };
}

function git(args: string[], env: NodeJS.ProcessEnv = gitEnv) {
  const result = spawnSync('git', args, { cwd: work, env, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function gitOk(args: string[], env?: NodeJS.ProcessEnv): string {
  const result = git(args, env);
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.output}`);
  return result.output.trim();
}

function remoteSha(ref: string): string {
  return gitOk(['ls-remote', 'origin', ref]).split(/\s+/)[0] ?? '';
}

function commit(file: string, withoutHooks: NodeJS.ProcessEnv): string {
  writeFileSync(path.join(work, file), `${file}\n`);
  gitOk(['add', file], withoutHooks);
  gitOk(['commit', '-q', '-m', file], withoutHooks);
  return gitOk(['rev-parse', 'HEAD']);
}

describe('lefthook pre-push branch-guard', () => {
  let devTip = '';
  let devParent = '';

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lefthook-branch-guard-'));
    const emptyGlobalConfig = path.join(root, 'gitconfig');
    writeFileSync(emptyGlobalConfig, '');
    gitEnv = isolatedEnv(emptyGlobalConfig);
    const withoutHooks = { ...gitEnv, LEFTHOOK: '0' };

    spawnSync('git', ['init', '-q', '--bare', path.join(root, 'remote.git')], { env: gitEnv });
    work = path.join(root, 'work');
    spawnSync('git', ['init', '-q', '-b', 'dev', work], { env: gitEnv });
    gitOk(['config', 'core.hooksPath', '.git/hooks']);
    gitOk(['remote', 'add', 'origin', path.join(root, 'remote.git')]);
    mkdirSync(path.join(work, 'scripts'));
    copyFileSync(path.join(REPOSITORY_ROOT, 'lefthook.yml'), path.join(work, 'lefthook.yml'));
    copyFileSync(
      path.join(REPOSITORY_ROOT, 'scripts', 'git-guard.sh'),
      path.join(work, 'scripts', 'git-guard.sh'),
    );
    gitOk(['add', '-A'], withoutHooks);
    gitOk(['commit', '-q', '-m', 'init'], withoutHooks);
    gitOk(['push', '-q', 'origin', 'dev', 'dev:refs/heads/master'], withoutHooks);
    devParent = commit('second', withoutHooks);
    devTip = commit('third', withoutHooks);
    gitOk(['push', '-q', 'origin', 'dev'], withoutHooks);
    gitOk(['fetch', '-q', 'origin']);
    const install = spawnSync(path.join(BIN_DIR, 'lefthook'), ['install'], {
      cwd: work,
      env: gitEnv,
      encoding: 'utf8',
    });
    assert.equal(install.status, 0, `${install.stdout}${install.stderr}`);
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('allows the dev → master fast-forward promotion', () => {
    const push = git(['push', 'origin', 'origin/dev:refs/heads/master']);
    assert.equal(push.status, 0, push.output);
    assert.equal(remoteSha('refs/heads/master'), devTip);
  });

  it('blocks rewinding master', () => {
    const push = git(['push', '--force', 'origin', `${devParent}:refs/heads/master`]);
    assert.notEqual(push.status, 0, push.output);
    assert.match(push.output, /git-guard: BLOCKED — non-fast-forward push to 'master'/);
    assert.equal(remoteSha('refs/heads/master'), devTip);
  });

  // A deletion pushes no files, so this is the case a file-filtered hook would
  // silently skip.
  for (const branch of ['master', 'dev']) {
    it(`blocks deleting ${branch}`, () => {
      const push = git(['push', 'origin', `:refs/heads/${branch}`]);
      assert.notEqual(push.status, 0, push.output);
      assert.match(
        push.output,
        new RegExp(`git-guard: BLOCKED — deleting remote branch '${branch}'`),
      );
      assert.equal(remoteSha(`refs/heads/${branch}`), devTip);
    });
  }

  it('blocks creating main', () => {
    const push = git(['push', 'origin', 'HEAD:refs/heads/main']);
    assert.notEqual(push.status, 0, push.output);
    assert.match(push.output, /git-guard: BLOCKED — pushing ref 'refs\/heads\/main'/);
    assert.equal(remoteSha('refs/heads/main'), '');
  });

  it('blocks a commit that is not on dev from reaching master, but lets its work branch push', () => {
    gitOk(['switch', '-q', '-c', 'feature/guarded']);
    const featureTip = commit('feature', { ...gitEnv, LEFTHOOK: '0' });

    const toMaster = git(['push', 'origin', 'HEAD:refs/heads/master']);
    assert.notEqual(toMaster.status, 0, toMaster.output);
    assert.match(toMaster.output, /git-guard: BLOCKED — pushing [0-9a-f]{40} to master/);
    assert.equal(remoteSha('refs/heads/master'), devTip);

    const toBranch = git(['push', 'origin', 'feature/guarded']);
    assert.equal(toBranch.status, 0, toBranch.output);
    assert.equal(remoteSha('refs/heads/feature/guarded'), featureTip);
  });
});

// The child run below re-enters this file; skipping this block there stops the
// recursion.
if (process.env[ISOLATION_CHILD] !== '1') {
  describe('lefthook-branch-guard test isolation', () => {
    it('leaves the host repository alone when run from inside a git hook', () => {
      const scratch = mkdtempSync(path.join(tmpdir(), 'lefthook-branch-guard-host-'));
      try {
        const emptyGlobalConfig = path.join(scratch, 'gitconfig');
        writeFileSync(emptyGlobalConfig, '');
        const host = path.join(scratch, 'host');
        spawnSync('git', ['init', '-q', host], { env: isolatedEnv(emptyGlobalConfig) });
        const hostConfig = path.join(host, '.git', 'config');
        const configBefore = readFileSync(hostConfig, 'utf8');

        // Reproduces the environment git hands a pre-push hook in `host`.
        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_DIR: path.join(host, '.git'),
          GIT_WORK_TREE: host,
          GIT_INDEX_FILE: path.join(host, '.git', 'index'),
          [ISOLATION_CHILD]: '1',
        };
        // Set by the node:test runner for its own workers; left in place, the
        // nested runner reports to a parent that isn't there and runs nothing.
        delete childEnv.NODE_TEST_CONTEXT;
        const child = spawnSync(path.join(BIN_DIR, 'tsx'), ['--test', THIS_FILE], {
          cwd: host,
          env: childEnv,
          encoding: 'utf8',
        });

        const output = `${child.stdout}${child.stderr}`;
        assert.equal(child.status, 0, output);
        assert.match(output, /ℹ pass 6\b/);
        assert.equal(readFileSync(hostConfig, 'utf8'), configBefore);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  });
}
