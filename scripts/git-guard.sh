#!/usr/bin/env bash
# git-guard.sh — mechanical enforcement of the AGENTS.md branch model.
#
# Single source of truth for the agent enforcement harness. Every layer is a
# thin adapter around this script:
#   - Claude Code PreToolUse hook  -> check-command  (.claude/hooks/git-guard-hook.sh)
#   - Codex PreToolUse hook        -> check-command  (.codex/hooks/git-guard-hook.sh)
#   - lefthook pre-commit          -> check-commit
#   - lefthook pre-push            -> check-push
#
# Rules enforced (see AGENTS.md "Branch model"):
#   - a branch named `main` must never be created, checked out, or pushed
#   - no direct commits on `master` or `dev` (`dev` allows commits only while
#     resolving a merge, i.e. MERGE_HEAD exists)
#   - `master` only receives SHAs that are already reachable from `dev`
#   - work branches are created from `dev`, never from `master`
#   - no force-pushes or deletions of `master`/`dev`, no `push --all/--mirror`
#
# Exit codes: 0 = allow, 2 = deny (reason on stderr). Compatible with
# Claude Code hooks, Codex hooks adapters, and native git hooks.
#
# Command-string analysis is heuristic (whitespace tokenization, split on
# `&&`/`||`/`;`/`|`); exotic quoting can slip past it. The GitHub rulesets
# layer (.github/rulesets/) is the authoritative backstop.
#
# Compatible with bash 3.2 (macOS system bash).

set -u
set -f # no globbing — command strings are tokenized with plain word splitting

WORKFLOW_HINT="See AGENTS.md: branch off dev (git switch -c feature/<slug> origin/dev), merge --no-ff into dev, promote with git push origin origin/dev:master."

deny() {
  echo "git-guard: BLOCKED — $1" >&2
  echo "git-guard: $WORKFLOW_HINT" >&2
  exit 2
}

# Directory the guarded git command operates in (set from `git -C <dir>`).
GIT_DIR_ARG=""

g() {
  if [ -n "$GIT_DIR_ARG" ]; then
    git -C "$GIT_DIR_ARG" "$@"
  else
    git "$@"
  fi
}

current_branch() {
  g rev-parse --abbrev-ref HEAD 2>/dev/null || true
}

in_merge() {
  local gitdir
  gitdir=$(g rev-parse --git-dir 2>/dev/null) || return 1
  [ -n "$GIT_DIR_ARG" ] && case "$gitdir" in /*) ;; *) gitdir="$GIT_DIR_ARG/$gitdir" ;; esac
  [ -f "$gitdir/MERGE_HEAD" ]
}

# True when $1 resolves to a commit reachable from dev (or origin/dev) —
# the definition of "went through the integration branch".
sha_reaches_dev() {
  local sha ref
  sha=$(g rev-parse -q --verify "$1^{commit}" 2>/dev/null) || return 1
  for ref in origin/dev dev; do
    if g rev-parse -q --verify "$ref" >/dev/null 2>&1 &&
      g merge-base --is-ancestor "$sha" "$ref" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

strip_ref_prefix() {
  echo "$1" | sed -e 's|^refs/heads/||' -e 's|^heads/||'
}

is_main_ref() {
  [ "$(strip_ref_prefix "$1")" = "main" ]
}

# ---------------------------------------------------------------------------
# check-commit: native pre-commit form of the branch rules.
# ---------------------------------------------------------------------------
check_commit() {
  local branch
  branch=$(current_branch)
  case "$branch" in
  main)
    deny "committing on 'main' — this branch must not exist; delete it and work off dev"
    ;;
  master)
    deny "direct commit on master — master only receives promotions from dev"
    ;;
  dev)
    in_merge || deny "direct commit on dev — dev only receives merges from work branches (commits are allowed mid-merge to resolve conflicts)"
    ;;
  esac
  exit 0
}

# ---------------------------------------------------------------------------
# check-push <remote> <url>: native pre-push hook. Reads refspec lines
# "<local-ref> <local-sha> <remote-ref> <remote-sha>" from stdin.
# ---------------------------------------------------------------------------
check_push() {
  local zero="0000000000000000000000000000000000000000"
  local local_ref local_sha remote_ref remote_sha branch
  while read -r local_ref local_sha remote_ref remote_sha; do
    [ -z "$remote_ref" ] && continue
    branch=$(strip_ref_prefix "$remote_ref")
    if [ "$branch" = "main" ]; then
      deny "pushing ref '$remote_ref' — a 'main' branch must never exist"
    fi
    if [ "$local_sha" = "$zero" ]; then
      case "$branch" in
      master | dev) deny "deleting remote branch '$branch'" ;;
      esac
      continue
    fi
    case "$branch" in
    master)
      sha_reaches_dev "$local_sha" ||
        deny "pushing $local_sha to master — the commit is not reachable from dev; master only receives promotions from dev"
      ;;
    esac
    # Reject non-fast-forward updates of the protected branches.
    case "$branch" in
    master | dev)
      if [ "$remote_sha" != "$zero" ] &&
        git rev-parse -q --verify "$remote_sha^{commit}" >/dev/null 2>&1 &&
        ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
        deny "non-fast-forward push to '$branch' — history of protected branches must never be rewritten"
      fi
      ;;
    esac
  done
  exit 0
}

# ---------------------------------------------------------------------------
# check-command "<shell string>": static + repo-state analysis of a proposed
# command, for agent-layer PreToolUse hooks.
# ---------------------------------------------------------------------------

# Analyze one tokenized git invocation ($@ = argv after `git` + global flags).
analyze_git() {
  local sub=$1
  shift
  case "$sub" in
  checkout | switch) analyze_checkout_switch "$@" ;;
  branch) analyze_branch "$@" ;;
  commit) analyze_commit_cmd ;;
  merge) analyze_merge "$@" ;;
  push) analyze_push "$@" ;;
  esac
}

analyze_checkout_switch() {
  local new_branch="" start_point="" arg positional=""
  while [ $# -gt 0 ]; do
    arg=$1
    case "$arg" in
    -b | -B | -c | -C | --orphan)
      shift
      [ $# -gt 0 ] && new_branch=$1
      ;;
    -t | --track)
      shift
      [ $# -gt 0 ] && is_main_ref "${1#*/}" &&
        deny "tracking a remote 'main' branch — a 'main' branch must never exist"
      ;;
    --) ;;
    -*) ;;
    *)
      if [ -n "$new_branch" ]; then
        start_point=$arg
      else
        positional=$arg
      fi
      ;;
    esac
    shift
  done

  if [ -n "$new_branch" ]; then
    is_main_ref "$new_branch" && deny "creating a branch named 'main' — it must never exist; master is the production branch"
    case "$start_point" in
    master | origin/master | refs/heads/master)
      deny "creating '$new_branch' from master — work branches are created from dev"
      ;;
    "")
      case "$(current_branch)" in
      master) deny "creating '$new_branch' while on master — work branches are created from dev (git switch -c $new_branch origin/dev)" ;;
      esac
      ;;
    esac
  elif [ -n "$positional" ] && is_main_ref "$positional"; then
    deny "checking out 'main' — this branch must never exist"
  fi
  return 0
}

analyze_branch() {
  local args="" arg deleting="" moving="" listing=""
  while [ $# -gt 0 ]; do
    arg=$1
    case "$arg" in
    -d | -D | --delete) deleting=1 ;;
    # rename/copy: the destination positional is a NEW branch name — enforce it.
    -m | -M | --move | -c | -C | --copy) moving=1 ;;
    # read-only query/list flags: `git branch` names a branch as a pattern or
    # filter argument, not as a branch to create (e.g. `git branch --list main`).
    -l | --list | -a | --all | -r | --remotes | --contains | --no-contains | \
      --merged | --no-merged | --points-at | --show-current | -v | -vv | \
      --verbose | --column | --no-column | --format | --format=* | --sort=* | \
      --edit-description)
      listing=1
      ;;
    --) ;;
    -*) ;;
    *) args="$args $arg" ;;
    esac
    shift
  done
  # Deletion and read-only list/query forms never create or rename a branch.
  [ -n "$deleting" ] && return 0
  { [ -n "$listing" ] && [ -z "$moving" ]; } && return 0
  local a
  for a in $args; do
    is_main_ref "$a" && deny "creating or renaming to a branch named 'main' — it must never exist"
  done
  # `git branch <new> master` — creating a branch off master.
  set -- $args
  if [ -z "$moving" ] && [ $# -ge 2 ]; then
    case "$2" in
    master | origin/master) deny "creating '$1' from master — work branches are created from dev" ;;
    esac
  fi
  return 0
}

analyze_commit_cmd() {
  local branch
  branch=$(current_branch)
  case "$branch" in
  main)
    deny "committing on 'main' — this branch must not exist; delete it and work off dev"
    ;;
  master)
    deny "direct commit on master — master only receives promotions from dev"
    ;;
  dev)
    in_merge || deny "direct commit on dev — dev only receives merges from work branches (commits are allowed mid-merge to resolve conflicts)"
    ;;
  esac
  return 0
}

analyze_merge() {
  local branch target="" arg
  branch=$(current_branch)
  for arg in "$@"; do
    case "$arg" in
    --) ;;
    -m | -F | -S | --gpg-sign=* | -X | --strategy=* | --strategy-option=*) ;;
    -*) ;;
    *) target=$arg ;;
    esac
  done
  case "$branch" in
  main)
    deny "merging while on 'main' — this branch must not exist"
    ;;
  master)
    case "$target" in
    dev | origin/dev | refs/heads/dev | "") ;;
    *) deny "merging '$target' into master — master only receives merges from dev" ;;
    esac
    ;;
  esac
  [ -n "$target" ] && is_main_ref "$target" &&
    deny "merging 'main' — this branch must not exist"
  return 0
}

analyze_push() {
  local remote="" refspecs="" force="" arg
  while [ $# -gt 0 ]; do
    arg=$1
    case "$arg" in
    --all | --branches) deny "git push --all — push branches explicitly so the branch model can be enforced" ;;
    --mirror) deny "git push --mirror — mirrors rewrite protected branches" ;;
    -f | --force | --force-with-lease | --force-with-lease=* | --force-if-includes) force=1 ;;
    -d | --delete)
      shift
      continue_with_delete "$remote" "$@"
      return 0
      ;;
    -o | --push-option | --repo | --receive-pack | --exec)
      shift
      ;;
    --) ;;
    -*) ;;
    *)
      if [ -z "$remote" ]; then
        remote=$arg
      else
        refspecs="$refspecs $arg"
      fi
      ;;
    esac
    shift
  done

  if [ -z "$refspecs" ]; then
    # `git push` / `git push origin`: destination is the current branch.
    local branch
    branch=$(current_branch)
    case "$branch" in
    main) deny "pushing 'main' — this branch must never exist" ;;
    master)
      [ -n "$force" ] && deny "force-pushing master"
      sha_reaches_dev "HEAD" ||
        deny "pushing master at a commit not reachable from dev — promote with: git push origin origin/dev:master"
      ;;
    dev)
      [ -n "$force" ] && deny "force-pushing dev"
      ;;
    esac
    return 0
  fi

  local spec src dst spec_force
  for spec in $refspecs; do
    spec_force=$force
    case "$spec" in +*)
      spec_force=1
      spec=${spec#+}
      ;;
    esac
    case "$spec" in
    *:*)
      src=${spec%%:*}
      dst=${spec#*:}
      ;;
    *)
      src=$spec
      dst=$spec
      ;;
    esac
    dst=$(strip_ref_prefix "$dst")
    case "$dst" in
    main)
      deny "pushing to 'main' — this branch must never exist"
      ;;
    master)
      [ -z "$src" ] && deny "deleting remote master"
      [ -n "$spec_force" ] && deny "force-pushing master"
      sha_reaches_dev "$src" ||
        deny "pushing '$src' to master — the commit is not reachable from dev; master only receives promotions from dev"
      ;;
    dev)
      [ -z "$src" ] && deny "deleting remote dev"
      [ -n "$spec_force" ] && deny "force-pushing dev"
      ;;
    esac
  done
  return 0
}

continue_with_delete() {
  # `git push --delete <remote> <branch>...` (remote may already be parsed).
  local remote=$1
  shift
  local arg
  for arg in "$@"; do
    case "$arg" in
    -*) ;;
    *)
      if [ -z "$remote" ]; then
        remote=$arg
        continue
      fi
      case "$(strip_ref_prefix "$arg")" in
      master) deny "deleting remote master" ;;
      dev) deny "deleting remote dev" ;;
      esac
      ;;
    esac
  done
}

check_command() {
  local cmd=$1
  # Fast path: nothing git-related in the command.
  case "$cmd" in
  *git*) ;;
  *) exit 0 ;;
  esac

  # The guard only polices THIS repository (worktrees included). Commands
  # targeting other repos — scratch fixtures, clones under /tmp — are allowed.
  local project_common
  project_common=$(git -C "$(cd "$(dirname "$0")/.." && pwd)" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)

  # Split compound commands into segments; analyze each git invocation.
  local segment cd_dir=""
  echo "$cmd" | sed -E $'s/\\|\\||&&|;|\\|/\\\n/g' | {
    while IFS= read -r segment; do
      # Tokenize (unquoted heuristic) and strip env-var prefixes.
      set -- $segment
      while [ $# -gt 0 ]; do
        case "$1" in
        *=*) shift ;;
        command | exec) shift ;;
        *) break ;;
        esac
      done
      [ $# -eq 0 ] && continue

      # Track directory changes so later segments are checked against the
      # repo they actually target. A dynamic target ($(...), $VAR) can't be
      # resolved statically — treated as "not this repo".
      if [ "$1" = "cd" ] || [ "$1" = "pushd" ]; then
        if [ $# -ge 2 ]; then
          case "$2" in
          *'$'* | *'`'*) cd_dir="__unknown__" ;;
          *) cd_dir=$2 ;;
          esac
        fi
        continue
      fi

      [ "$1" = "git" ] || continue
      shift

      # Consume git global flags; remember -C <dir> for repo-state checks.
      GIT_DIR_ARG=""
      while [ $# -gt 0 ]; do
        case "$1" in
        -C)
          shift
          [ $# -gt 0 ] && GIT_DIR_ARG=$1
          shift
          ;;
        -c | --git-dir | --work-tree | --namespace)
          shift
          shift
          ;;
        --git-dir=* | --work-tree=* | -c*) shift ;;
        -*) shift ;;
        *) break ;;
        esac
      done
      [ $# -eq 0 ] && continue

      [ -z "$GIT_DIR_ARG" ] && [ -n "$cd_dir" ] && GIT_DIR_ARG=$cd_dir
      [ "$GIT_DIR_ARG" = "__unknown__" ] && continue
      if [ -n "$project_common" ]; then
        local target_common
        target_common=$(g rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
        [ "$target_common" = "$project_common" ] || continue
      fi

      analyze_git "$@"
    done
    exit 0
  }
  # The braced group runs in a subshell; propagate its deny exit code.
  local rc=$?
  [ $rc -ne 0 ] && exit $rc
  exit 0
}

# ---------------------------------------------------------------------------
# doctor: environment sanity report (never blocks).
# ---------------------------------------------------------------------------
doctor() {
  local ok=1
  echo "git-guard doctor"
  local hooks_path
  hooks_path=$(git config core.hooksPath 2>/dev/null || true)
  if [ -n "$hooks_path" ] && [ "$hooks_path" != ".git/hooks" ] &&
    ! grep -qs lefthook "$hooks_path/pre-commit" 2>/dev/null; then
    echo "  WARN core.hooksPath=$hooks_path shadows .git/hooks and does not delegate to lefthook — the pre-commit/pre-push guard will NOT run in this clone"
    ok=0
  fi
  if git rev-parse -q --verify main >/dev/null 2>&1; then
    echo "  WARN local branch 'main' exists — delete it (git branch -D main); the branch model forbids it"
    ok=0
  fi
  if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
    echo "  WARN origin has a 'main' branch — it must be deleted"
    ok=0
  fi
  if git rev-parse -q --verify origin/master >/dev/null 2>&1 &&
    git rev-parse -q --verify origin/dev >/dev/null 2>&1; then
    if ! git merge-base --is-ancestor origin/master origin/dev 2>/dev/null; then
      echo "  WARN origin/master is not an ancestor of origin/dev — a commit reached master without going through dev; back-merge to reconcile"
      ok=0
    fi
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "  WARN jq not installed — the Claude/Codex hook adapters fall back to python3 for JSON parsing"
  fi
  [ $ok -eq 1 ] && echo "  OK no branch-model problems detected"
  exit 0
}

case "${1:-}" in
check-command)
  shift
  check_command "${1:-}"
  ;;
check-commit) check_commit ;;
check-push)
  shift
  check_push "$@"
  ;;
doctor) doctor ;;
*)
  echo "usage: git-guard.sh check-command \"<shell string>\" | check-commit | check-push <remote> <url> | doctor" >&2
  exit 64
  ;;
esac
