# Mixdog Personal (Windows x64)

This is the personal Fork, not an upstream release. Never create a PR or push
to `tribgames/mixdog`. `origin` is `https://github.com/namidainfo/mixdog.git`;
`upstream` is a fetch-only source. Keep `main` free of personal changes and
work on `personal`. Personal release versions use `<upstream-version>-personal.N`.

## Clone and local protection

```powershell
git clone --branch personal https://github.com/namidainfo/mixdog.git mixdog-personal
Set-Location mixdog-personal
git remote add upstream https://github.com/tribgames/mixdog.git
node scripts/personal-repository.mjs
```

The guard checks both exact remotes, disables upstream pushes, and selects
`origin` for personal pushes. Git local configuration is not transferred by
clone, so run the guard on each PC. No script publishes an upstream PR.

## Build and install

Use the repository's normal dependency preparation (`npm ci` at the root and
in `apps/desktop`) and build with the personal configuration:

```powershell
npm run build:win:personal --prefix apps/desktop
```

The installer is written to a newly allocated `apps/desktop/dist-personal-release-*/`
directory, without clearing an older or running package. This command never
publishes a release. The application and URL scheme remain separate from the
official app: `io.namidainfo.mixdog.personal` / `mixdog-personal`.

The existing personal profile stays at
`%LOCALAPPDATA%\mixdog-dev\personal` (including `home`, `data`, `projects.json`,
`bridges` and `runtime`). Installing on the same PC keeps that path. Another PC
has its own profile; installing the executable does not transfer conversations,
settings or credentials. If transferring personal data, close both apps/daemons
and back up the source and destination first. Re-authenticate on the destination
instead of copying OAuth credentials indiscriminately. Do not overwrite the
official application's profile.

Windows trust is added to existing TLS roots; hostname and certificate
verification stay enabled. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0` or
disable Git/npm SSL verification. OAuth TLS diagnostics are off by default.
The official updater stays disabled in the personal app.

Codex logs are read only. Numeric calibration is cached separately beside the
usage ledger as `*.codex-calibration.sqlite`. Only matching authenticated
accounts and historical 5H/7D observations can influence estimates; external
requests and readings are never added to Mixdog's usage ledger or chart data.
Missing identity or pricing supplies no calibration, not invented usage.

## Prepare an upstream update safely

Do not merge into the running/validated personal checkout first. Start from a
clean committed `personal` branch and prepare the merge in a new worktree:

```powershell
git status --short
git fetch upstream --no-tags
$mergeBranch = 'personal-upstream-' + [guid]::NewGuid().ToString('N')
$mergePath = Join-Path ([IO.Path]::GetTempPath()) $mergeBranch
git worktree add -b $mergeBranch $mergePath personal
Set-Location $mergePath
git merge --no-commit --no-ff upstream/main
```

Stop if the source checkout is dirty. The unique worktree leaves `personal` and
its data unchanged. Resolve conflicts in the merge worktree; never choose
`ours`/`theirs` globally. Recheck profile identity, the Windows CA hook, disabled
updater, protocol, personal builder overrides and calibration-only attribution.
If rejecting the merge, `git merge --abort` affects only that worktree; do not
delete either checkout or use `reset --hard` on personal changes.

In the merge worktree, run the relevant runtime/desktop tests, then the personal
build. Verify the unpacked package, sign-in and data continuity in an isolated
test profile before committing the merge. Only a verified merge is promoted:

```powershell
git commit -m "merge: integrate verified upstream update into personal"
Set-Location C:\Users\admin\Documents\mixdog-personal
git switch personal
git merge --ff-only $mergeBranch
git push origin personal:personal
```

If `--ff-only` refuses because personal changed meanwhile, prepare and verify a
new merge against the new personal tip; do not force-push. Keep the prior
installer and committed source as rollback inputs. A backup is required before
testing an update that might migrate live profile data.
