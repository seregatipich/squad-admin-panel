#!/usr/bin/env tsx
/**
 * solve-issues-parallel.ts
 *
 * Solves GitHub issues in parallel with Claude Managed Agents
 * (https://platform.claude.com/docs/en/managed-agents/overview): one cloud
 * sandbox session per issue, each with this repository mounted and checked
 * out on `dev`. Every session implements the issue on its own
 * `feature/issue-<n>-<slug>` branch, runs the local gate, and pushes the
 * branch and posts reviewable handoff evidence on the issue — the
 * "parallel-wave handoff" terminal state from AGENTS.md. An orchestrator
 * (you) then merges the pushed branches into `dev` serially.
 *
 * Usage:
 *   pnpm solve:issues -- 207 203 194              # explicit issue numbers
 *   pnpm solve:issues -- --label bug --limit 3    # open issues by label
 *   pnpm solve:issues -- 207 --dry-run            # print the plan, no API calls
 *
 * Requires:
 *   ANTHROPIC_API_KEY  Claude API key (Managed Agents beta).
 *   GITHUB_TOKEN       Token with repo read/write scope; falls back to
 *                      `gh auth token`. Passed to the Managed Agents API as
 *                      the repository resource's authorization_token — it is
 *                      never embedded in prompts.
 *   gh                 Authenticated GitHub CLI (issue lookup).
 *
 * See docs/development/solve-issues-parallel.md for the full runbook.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

/** Parsed CLI configuration for one runner invocation. */
export interface CliConfig {
  /** Explicit issue numbers to solve. Empty when selecting by label. */
  issues: number[];
  /** Open-issue label filter, used when no explicit numbers are given. */
  label?: string;
  /** Maximum issues fetched in label mode. */
  limit: number;
  /** Maximum sessions running at once. */
  concurrency: number;
  /** Model ID for the Managed Agent. */
  model: string;
  /** Per-session wall-clock budget in minutes. */
  timeoutMin: number;
  /** `owner/name` repository slug; auto-detected from `gh` when omitted. */
  repo?: string;
  /** Print the plan and prompts without calling the Claude API. */
  dryRun: boolean;
  /** Echo agent tool use and messages while sessions run. */
  verbose: boolean;
  /** Print usage and exit. */
  help: boolean;
}

/** A GitHub issue in the shape the prompt builder needs. */
export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  url: string;
}

/** Outcome of one Managed Agents session. */
export interface IssueResult {
  issue: IssueInfo;
  status: 'solved' | 'failed' | 'timed-out';
  /** Final agent message (or error description). */
  summary: string;
  sessionId?: string;
}

/** Raised for invalid CLI input; main() prints usage and exits 2. */
export class UsageError extends Error {}

export const USAGE = `Usage: pnpm solve:issues -- [issue numbers...] [options]

Selection (one of):
  <numbers...>          Issue numbers to solve, e.g. "207 203 194"
  --label <label>       Open issues carrying <label> (with --limit, default 5)

Options:
  --limit <n>           Max issues fetched in --label mode (default 5)
  --concurrency <n>     Parallel sessions (default 3)
  --model <id>          Agent model (default claude-opus-4-8)
  --timeout-min <n>     Per-session budget in minutes (default 45)
  --repo <owner/name>   Repository (default: gh repo view of the cwd)
  --dry-run             Print plan and prompts without calling the Claude API
  --verbose             Stream agent tool use and messages to stdout
  --help                Show this help`;

const FLAG_DEFAULTS: Pick<CliConfig, 'limit' | 'concurrency' | 'model' | 'timeoutMin'> = {
  limit: 5,
  concurrency: 3,
  model: 'claude-opus-4-8',
  timeoutMin: 45,
};

/** Agent/environment resource names, used to find-or-create across runs. */
const AGENT_NAME = 'squad-admin-panel issue solver';
const ENVIRONMENT_NAME = 'squad-admin-panel issue solver env';

/**
 * Parses CLI arguments into a {@link CliConfig}.
 *
 * @param argv - Arguments after the script path (i.e. `process.argv.slice(2)`).
 * @throws UsageError on unknown flags, malformed values, or when neither
 *   issue numbers nor `--label` are provided (unless `--help`).
 */
export function parseCliArgs(argv: readonly string[]): CliConfig {
  const cfg: CliConfig = {
    issues: [],
    ...FLAG_DEFAULTS,
    dryRun: false,
    verbose: false,
    help: false,
  };

  const takeValue = (flag: string, next: string | undefined): string => {
    if (next === undefined || next.startsWith('--')) {
      throw new UsageError(`${flag} requires a value`);
    }
    return next;
  };
  const takePositiveInt = (flag: string, next: string | undefined): number => {
    const raw = takeValue(flag, next);
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new UsageError(`${flag} must be a positive integer, got "${raw}"`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === '--') {
      // pnpm forwards the literal `--` separator from `pnpm solve:issues -- ...`.
      continue;
    }
    switch (arg) {
      case '--help':
        cfg.help = true;
        break;
      case '--dry-run':
        cfg.dryRun = true;
        break;
      case '--verbose':
        cfg.verbose = true;
        break;
      case '--label':
        cfg.label = takeValue(arg, argv[++i]);
        break;
      case '--repo':
        cfg.repo = takeValue(arg, argv[++i]);
        break;
      case '--model':
        cfg.model = takeValue(arg, argv[++i]);
        break;
      case '--limit':
        cfg.limit = takePositiveInt(arg, argv[++i]);
        break;
      case '--concurrency':
        cfg.concurrency = takePositiveInt(arg, argv[++i]);
        break;
      case '--timeout-min':
        cfg.timeoutMin = takePositiveInt(arg, argv[++i]);
        break;
      default: {
        if (arg.startsWith('--')) {
          throw new UsageError(`Unknown option: ${arg}`);
        }
        const value = Number(arg);
        if (!Number.isInteger(value) || value <= 0) {
          throw new UsageError(`Expected an issue number, got "${arg}"`);
        }
        if (!cfg.issues.includes(value)) {
          cfg.issues.push(value);
        }
      }
    }
  }

  if (!cfg.help && cfg.issues.length === 0 && !cfg.label) {
    throw new UsageError('Provide issue numbers or --label. See --help.');
  }
  return cfg;
}

/**
 * Converts an issue title to a short branch-safe slug: lowercase ASCII words
 * joined by dashes, truncated to at most 40 characters on a word boundary.
 * Returns '' when the title has no ASCII words (e.g. fully Cyrillic titles).
 */
export function slugify(title: string): string {
  const words = title.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let slug = '';
  for (const word of words) {
    const candidate = slug === '' ? word : `${slug}-${word}`;
    if (candidate.length > 40) {
      break;
    }
    slug = candidate;
  }
  return slug;
}

/** Builds the AGENTS.md-conformant work branch name for an issue. */
export function branchNameFor(issue: Pick<IssueInfo, 'number' | 'title'>): string {
  const slug = slugify(issue.title);
  return slug === '' ? `feature/issue-${issue.number}` : `feature/issue-${issue.number}-${slug}`;
}

/**
 * Builds the task prompt sent as the session's first user message. The repo
 * is already mounted and authenticated by the `github_repository` session
 * resource, so the prompt contains no credentials.
 */
export function buildTaskPrompt(issue: IssueInfo, repoSlug: string, mountPath: string): string {
  const branch = branchNameFor(issue);
  return `You are working in a clone of ${repoSlug} mounted at ${mountPath}, checked out on the \`dev\` branch with push access already configured.

Solve GitHub issue #${issue.number}: ${issue.title}
${issue.url}

--- ISSUE BODY ---
${issue.body.trim() === '' ? '(no description)' : issue.body}
--- END ISSUE BODY ---

First read AGENTS.md at the repository root — its rules are mandatory. Then:

1. Create the work branch \`${branch}\` off the current \`dev\` checkout. Never commit to \`dev\` or \`master\`, and never create or target a branch named \`main\`.
2. Run \`pnpm install --frozen-lockfile\` before anything else (fresh clone).
3. Implement the issue with tests, per the AGENTS.md testing policy: a regression test that fails before the fix and passes after it for bugs, integration tests for new modules.
4. Run the local gate: \`pnpm turbo run typecheck\`, \`pnpm exec biome check .\`, and the affected packages' tests. If a check cannot run in this sandbox (e.g. Docker-backed suites), say exactly what was skipped and why — never fake or weaken it.
5. Commit with a conventional message that references #${issue.number}, then push the branch: \`git push -u origin ${branch}\`.
6. Do NOT merge into \`dev\`, do NOT push \`dev\` or \`master\`, and do NOT open pull requests. Your terminal state is the pushed feature branch (AGENTS.md "Parallel-wave handoff"); verify it with \`bash scripts/verify-done.sh --feature\`.
7. Post a \`Feature-branch handoff evidence — not yet 100% complete\` comment on issue #${issue.number}, exactly as required by AGENTS.md. It must contain the branch and commit SHA, point-by-point requirement coverage, exact test and gate commands with results, real runtime/functionality verification and the tools used, verification provenance, and all skips or limitations. State explicitly that final completion is pending merge to \`dev\`, full \`dev\` CI, and the integrating agent's completion verification. Re-read the published comment to verify it is visible, and retain its URL.

End with a final report: the branch name, what changed and why, test commands run with their results, anything you had to skip, and the verified GitHub handoff-evidence comment URL.`;
}

/**
 * Runs `worker` over `items` with at most `concurrency` invocations in
 * flight, preserving input order in the returned results.
 */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index] as T, index);
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}

function detectRepoSlug(): string {
  return gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
}

function resolveGithubToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const token = gh(['auth', 'token']).trim();
    if (token !== '') {
      return token;
    }
  } catch {
    // fall through to the error below
  }
  throw new Error('No GitHub token: set GITHUB_TOKEN or authenticate `gh` (gh auth login).');
}

function fetchIssue(repo: string, num: number): IssueInfo {
  const raw = gh(['issue', 'view', String(num), '--repo', repo, '--json', 'number,title,body,url']);
  return JSON.parse(raw) as IssueInfo;
}

function fetchIssuesByLabel(repo: string, label: string, limit: number): IssueInfo[] {
  const raw = gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--label',
    label,
    '--limit',
    String(limit),
    '--json',
    'number,title,body,url',
  ]);
  return JSON.parse(raw) as IssueInfo[];
}

/** System prompt for the solver agent resource (created once, reused). */
const AGENT_SYSTEM_PROMPT = `You are an autonomous software engineer solving one GitHub issue per session in the squad-admin-panel repository (TypeScript pnpm/turbo monorepo with a Go bridge). The repository's AGENTS.md is the authoritative rulebook: branch model (work branches off dev, never touch master, never create main), mandatory tests for every change, the local gate (typecheck, biome check, affected tests), conventional commits, and a visible GitHub issue comment containing complete feature-branch handoff evidence. Work autonomously until the issue is solved, the work branch is pushed, and the issue comment is published and verified; be explicit about anything you could not verify in the sandbox.`;

async function ensureAgent(client: Anthropic, model: string): Promise<string> {
  for await (const agent of client.beta.agents.list()) {
    if (agent.name === AGENT_NAME) {
      return agent.id;
    }
  }
  const agent = await client.beta.agents.create({
    name: AGENT_NAME,
    model: model as Parameters<typeof client.beta.agents.create>[0]['model'],
    system: AGENT_SYSTEM_PROMPT,
    tools: [{ type: 'agent_toolset_20260401' }],
  });
  return agent.id;
}

async function ensureEnvironment(client: Anthropic): Promise<string> {
  for await (const env of client.beta.environments.list()) {
    if (env.name === ENVIRONMENT_NAME) {
      return env.id;
    }
  }
  const env = await client.beta.environments.create({
    name: ENVIRONMENT_NAME,
    config: { type: 'cloud', networking: { type: 'unrestricted' } },
  });
  return env.id;
}

interface SessionContext {
  client: Anthropic;
  agentId: string;
  environmentId: string;
  repoSlug: string;
  githubToken: string;
  model: string;
  timeoutMin: number;
  verbose: boolean;
}

/**
 * Runs one Managed Agents session for one issue: mounts the repo on `dev`,
 * sends the task prompt, streams events until the session goes idle, and
 * returns the final agent message. Never throws — failures and timeouts are
 * folded into the returned {@link IssueResult}.
 */
async function solveIssue(ctx: SessionContext, issue: IssueInfo): Promise<IssueResult> {
  const tag = `[#${issue.number}]`;
  const mountPath = `/workspace/${ctx.repoSlug.split('/')[1]}`;
  let sessionId: string | undefined;
  try {
    const session = await ctx.client.beta.sessions.create({
      agent: {
        type: 'agent_with_overrides',
        id: ctx.agentId,
        model: { id: ctx.model as Anthropic.Beta.BetaManagedAgentsModel },
      },
      environment_id: ctx.environmentId,
      title: `issue-${issue.number}: ${issue.title}`.slice(0, 200),
      resources: [
        {
          type: 'github_repository',
          url: `https://github.com/${ctx.repoSlug}`,
          authorization_token: ctx.githubToken,
          checkout: { type: 'branch', name: 'dev' },
          mount_path: mountPath,
        },
      ],
    });
    sessionId = session.id;
    console.log(`${tag} session ${session.id} started (branch ${branchNameFor(issue)})`);

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), ctx.timeoutMin * 60_000);
    try {
      const stream = await ctx.client.beta.sessions.events.stream(
        session.id,
        {},
        { signal: controller.signal },
      );
      await ctx.client.beta.sessions.events.send(session.id, {
        events: [
          {
            type: 'user.message',
            content: [{ type: 'text', text: buildTaskPrompt(issue, ctx.repoSlug, mountPath) }],
          },
        ],
      });

      let lastMessage = '';
      for await (const event of stream) {
        switch (event.type) {
          case 'agent.message': {
            const text = event.content.map((block) => ('text' in block ? block.text : '')).join('');
            if (text.trim() !== '') {
              lastMessage = text;
            }
            if (ctx.verbose) {
              console.log(`${tag} ${text}`);
            }
            break;
          }
          case 'agent.tool_use':
            if (ctx.verbose) {
              console.log(`${tag} tool: ${event.name}`);
            }
            break;
          case 'session.error':
            return {
              issue,
              status: 'failed',
              summary: `session error: ${JSON.stringify(event.error)}`,
              sessionId,
            };
          case 'session.status_terminated':
            return {
              issue,
              status: 'failed',
              summary: lastMessage || 'session terminated before finishing',
              sessionId,
            };
          case 'session.status_idle':
            return { issue, status: 'solved', summary: lastMessage, sessionId };
          default:
            break;
        }
      }
      return {
        issue,
        status: 'failed',
        summary: lastMessage || 'event stream ended without an idle status',
        sessionId,
      };
    } finally {
      clearTimeout(deadline);
    }
  } catch (error) {
    const aborted =
      error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message));
    if (aborted) {
      return {
        issue,
        status: 'timed-out',
        summary: `no idle status within ${ctx.timeoutMin} min — inspect session ${sessionId ?? '?'} in the Console`,
        sessionId,
      };
    }
    return {
      issue,
      status: 'failed',
      summary: error instanceof Error ? error.message : String(error),
      sessionId,
    };
  }
}

function printReport(results: IssueResult[]): void {
  console.log('\n=== Results ===');
  for (const r of results) {
    const header = `#${r.issue.number} ${r.status.toUpperCase()} (${r.issue.title})`;
    console.log(`\n${header}`);
    if (r.sessionId) {
      console.log(`  session: ${r.sessionId}`);
    }
    if (r.status !== 'timed-out') {
      console.log(`  branch:  ${branchNameFor(r.issue)}`);
    }
    const summary = r.summary.trim() === '' ? '(no final message)' : r.summary.trim();
    console.log(summary.replace(/^/gm, '  '));
  }
  const solved = results.filter((r) => r.status === 'solved').length;
  console.log(`\n${solved}/${results.length} sessions finished cleanly.`);
  console.log('Next: review each pushed branch and merge into dev serially (see AGENTS.md).');
}

async function main(): Promise<void> {
  let cfg: CliConfig;
  try {
    cfg = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      process.exit(2);
    }
    throw error;
  }
  if (cfg.help) {
    console.log(USAGE);
    return;
  }

  const repoSlug = cfg.repo ?? detectRepoSlug();
  const issues =
    cfg.issues.length > 0
      ? cfg.issues.map((num) => fetchIssue(repoSlug, num))
      : fetchIssuesByLabel(repoSlug, cfg.label as string, cfg.limit);
  if (issues.length === 0) {
    console.error(`No open issues matched label "${cfg.label}" in ${repoSlug}.`);
    process.exit(1);
  }

  console.log(
    `Solving ${issues.length} issue(s) from ${repoSlug} with concurrency ${cfg.concurrency}, model ${cfg.model}:`,
  );
  for (const issue of issues) {
    console.log(`  #${issue.number} ${issue.title} -> ${branchNameFor(issue)}`);
  }

  if (cfg.dryRun) {
    const mountPath = `/workspace/${repoSlug.split('/')[1]}`;
    for (const issue of issues) {
      console.log(`\n--- prompt for #${issue.number} ---`);
      console.log(buildTaskPrompt(issue, repoSlug, mountPath));
    }
    console.log('\nDry run: no sessions were created.');
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required (Managed Agents beta).');
    process.exit(1);
  }
  const githubToken = resolveGithubToken();
  const client = new Anthropic();
  const [agentId, environmentId] = await Promise.all([
    ensureAgent(client, cfg.model),
    ensureEnvironment(client),
  ]);
  console.log(`Agent ${agentId}, environment ${environmentId}.`);

  const ctx: SessionContext = {
    client,
    agentId,
    environmentId,
    repoSlug,
    githubToken,
    model: cfg.model,
    timeoutMin: cfg.timeoutMin,
    verbose: cfg.verbose,
  };
  const results = await runPool(issues, cfg.concurrency, (issue) => solveIssue(ctx, issue));
  printReport(results);
  process.exitCode = results.every((r) => r.status === 'solved') ? 0 : 1;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
