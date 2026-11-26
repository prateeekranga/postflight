# CI recipes

## Local Git pre-commit hook

Use this hook in a repository that keeps campaign Markdown files under
`drafts/`. When a commit changes those files, the hook checks the staged
version of the entire folder. Unstaged edits stay out of the check, even if
they affect the same file. With `--strict`, either errors or warnings block
the commit.

Build the CLI from a PostFlight checkout with Node.js 20 or later, then record
its absolute path in your campaign repository's local Git configuration.

~~~sh
# In the PostFlight checkout
npm ci
npm run build:packages
postflight_cli="$(pwd)/packages/cli/dist/index.js"

# In the campaign repository
cd /path/to/campaign-repo
git config --local postflight.cli "$postflight_cli"
~~~

Use `git rev-parse --git-path hooks/pre-commit` to find the hook path.
For a new hook, save the script there. If a hook already exists, save the
script as a separate executable file and call it from the existing hook.
Propagate the script's exit status so a lint failure blocks the commit.

~~~sh
#!/bin/sh
set -eu

drafts=':(icase,glob)drafts/**/*.md'
if git diff --cached --quiet -- "$drafts"; then
    exit 0
fi

snapshot=$(mktemp -d "${TMPDIR:-/tmp}/postflight.XXXXXX")
trap 'rm -rf "$snapshot"' 0

git ls-files --cached -z -- "$drafts" > "$snapshot/files"
[ -s "$snapshot/files" ] || exit 0

cli=$(git config --local --get postflight.cli) || {
    printf '%s\n' 'Set postflight.cli to the absolute path of the built CLI.' >&2
    exit 1
}

git checkout-index --stdin -z --prefix="$snapshot/tree/" < "$snapshot/files"
node "$cli" check "$snapshot/tree/drafts" --strict
~~~

For a new hook, make it executable.

~~~sh
chmod +x "$(git rev-parse --git-path hooks/pre-commit)"
~~~

Stage a Markdown draft and commit it to try the hook. Git stops the commit if
PostFlight reports a problem. After fixing it, stage the updated file before
retrying. Git hooks are local to each checkout, so keep a CI check if you need
the same gate for everyone.
