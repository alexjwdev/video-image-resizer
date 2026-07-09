# Contributing

Thanks for wanting to help out.
This guide assumes you have never really used git before, and walks through exactly the commands you need to contribute to this specific project.
You don't need to know anything beyond what's written here.

## 1. Fork the repo, then clone your fork

A **fork** is your own personal copy of this repository on GitHub.
A **clone** is a copy of a repository (yours or someone else's) downloaded onto your own computer.

You need both: fork first, so you have somewhere on GitHub to push your changes to, then clone your fork so you can edit the code locally.

1. On GitHub, open this repository and click the **Fork** button in the top right.
2. GitHub creates a copy under your own account, e.g. `github.com/your-username/image-resizer`.
3. On your computer, clone your fork (not the original):

```bash
git clone https://github.com/your-username/image-resizer.git
cd image-resizer
```

## 2. Create a branch before you change anything

A branch is a named, isolated line of work.
Making your changes on a branch (instead of directly on `main`) keeps `main` clean and makes it easy for you to work on more than one thing at a time.

```bash
git checkout -b fix-something
```

Pick a short, descriptive name instead of `fix-something`, like `fix-video-poster-bug` or `add-webp-quality-note`.

## 3. The edit loop

This is the cycle you'll repeat for every change:

1. Edit files in your normal editor.
2. See what changed:

```bash
git status
```

This lists every file you've modified, added, or deleted.

3. Stage the specific files you want to commit:

```bash
git add path/to/file.js
```

Avoid `git add .` (which stages everything in the current folder) until you're confident you know exactly what changed.
It's easy to accidentally stage a stray log file, a local config change, or something you didn't mean to commit.
Staging files by name keeps every commit intentional.

4. Commit your staged changes with a message:

```bash
git commit -m "Fix video poster frame not generating for short clips"
```

A good commit message is a short, specific sentence describing *what changed and why*, written so someone skimming the history six months from now understands it without opening the diff.
"fix bug" is not a good commit message; "Fix video poster frame not generating for short clips" is.

5. Repeat steps 1-4 as many times as you need. Small, focused commits are easier to review than one giant commit at the end.

## 4. Push your branch to GitHub

The first time you push a new branch, tell git to link it to your fork on GitHub:

```bash
git push -u origin fix-something
```

After that first push, for any new commits on the same branch, you can just run:

```bash
git push
```

## 5. Open a Pull Request

A Pull Request (PR) asks the project maintainer to review your branch and merge it into `main`.

1. Go to your fork on GitHub. You'll usually see a banner offering to open a PR for your recently pushed branch - click it.
2. If you don't see the banner, go to the **Pull requests** tab and click **New pull request**, then choose your branch.
3. In the PR description, write:
   - What you changed and why.
   - How you tested it (for this project, that usually means running `node .claude/skills/run-image-resizer/driver.mjs`, see the README).
   - Anything you're unsure about or want feedback on.
4. Submit the PR.

## 6. Responding to review comments

A maintainer may leave comments directly on lines of your diff, asking for changes or explaining a concern.
You don't need to open a new PR to address them.

1. Make the requested changes locally, on the **same branch** you already have checked out.
2. Repeat the edit loop from step 3: `git status`, `git add`, `git commit -m "..."`.
3. `git push` (no `-u` needed this time, since the branch is already linked).
4. Your new commits appear automatically in the same PR - there's nothing extra to do.

## 7. Merging

"Merging" means taking the changes from your branch and applying them onto `main`.

Once your PR is approved, it gets merged in one of two ways:

- **Merging via the GitHub UI** (the usual path here): the maintainer clicks the **Merge pull request** button on the PR page. This is the safest option and the one you should expect - it merges through GitHub directly, no local steps needed on your end.
- **Merging locally**: someone with write access could merge your branch into `main` on their own machine and push the result. This is rarer and not something you'll usually need to do yourself as a contributor.

After your PR is merged, update your local copy of `main`:

```bash
git checkout main
git pull
```

Your merged change is now in your local `main`.
You can now safely delete the branch you were working on, since its work has been merged:

```bash
git branch -d fix-something
```

## If something goes wrong

Git rarely loses work permanently, but a few commands genuinely can, so know the safe ones and stop before the dangerous ones.

**Safe, useful commands:**

- See recent history: `git log` (press `q` to exit the view).
- See what's currently changed but not committed: `git status`.
- Undo changes to a file you haven't committed yet, restoring it to the last committed version: `git restore path/to/file.js`.

**Stop and ask for help before running any of these** - don't guess, since they can permanently discard work:

- `git reset --hard`
- `git push --force`
- `git clean -f`
- Anything else you found in a search result that mentions "force" or "hard" and you're not 100% sure what it does.

If you're ever unsure whether a command is safe, it's always fine to stop, copy the command, and ask before running it.
