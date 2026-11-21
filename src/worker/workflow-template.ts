/**
 * The workflow the panel installs into a site repo.
 *
 * Two things about this file matter more than the rest:
 *
 * 1. **No expression is interpolated into a `run:` line.** GitHub's own
 *    security guidance is explicit that `${{ inputs.x }}` inside `run:` is a
 *    script-injection vector. Every input reaches the shell through `env:`
 *    instead, and is quoted. The panel also validates `args`, but this file
 *    does not rely on that.
 *
 * 2. **The push is conditional and narrow.** Only `covers`, `music` and `og`
 *    commit anything; `build` and the tests exist to prove a change is good
 *    without making one. That decision arrives as an input the panel sets, so
 *    the workflow stays generic.
 */

export const WORKFLOW_TEMPLATE = `name: Admin Task

# Installed by the OnPaper admin panel. Dispatched from the panel only.
#
# Every input reaches the shell through env, never spliced into a run: line —
# see GitHub's "script injections" guidance. Quoting with "$VAR" is what keeps a
# value from being re-parsed as shell.
on:
  workflow_dispatch:
    inputs:
      task:
        description: '要运行的 npm 脚本'
        required: true
        type: choice
        options:
          - covers
          - music
          - og
          - build
          - build:clean
          - clean
          - shots
          - test:shelf
          - test:render
          - test:font-source
      args:
        description: '传给脚本的参数，可为空'
        required: false
        default: ''
        type: string
      commit:
        description: '是否把结果提交回仓库（true / false）'
        required: false
        default: 'true'
        type: string

# The default is read-only; the commit step needs exactly one more bit.
permissions:
  contents: write

concurrency:
  group: admin-task-\${{ inputs.task }}
  cancel-in-progress: false

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          # The dispatched ref. Read here in YAML, never inside a run: line.
          ref: \${{ github.ref }}
          persist-credentials: true

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run task
        env:
          TASK: \${{ inputs.task }}
          TASK_ARGS: \${{ inputs.args }}
        run: |
          set -euo pipefail
          echo "running npm run $TASK"
          if [ -n "\${TASK_ARGS:-}" ]; then
            # One quoted argument, not a word-split list.
            #
            # The scripts read each argument as one entry title, and a title can
            # contain spaces. A title like "100 种生活" was passed unquoted and arrived as
            # the two titles "100" and "种生活", so neither was found and the run
            # completed successfully having done nothing. Quoting makes the value
            # one argument, which is the only interpretation the panel offers
            # ("补这一条").
            npm run "$TASK" -- "$TASK_ARGS"
          else
            npm run "$TASK"
          fi

      - name: Commit results
        if: \${{ inputs.commit == 'true' }}
        env:
          TASK: \${{ inputs.task }}
          BRANCH: \${{ github.ref_name }}
        run: |
          set -euo pipefail
          if [ -z "$(git status --porcelain)" ]; then
            echo "no changes to commit"
            exit 0
          fi
          git config user.name "onpaper-admin"
          git config user.email "onpaper-admin@users.noreply.github.com"
          git add -A
          git commit -m "chore: 面板运行 npm run $TASK"
          # The branch arrives through env, like every other input, so no
          # expression is ever expanded inside a shell line.
          git push origin "HEAD:$BRANCH"
`

/** Where the panel writes it, relative to the repo root. */
export const WORKFLOW_INSTALL_PATH = '.github/workflows/admin-task.yml'
