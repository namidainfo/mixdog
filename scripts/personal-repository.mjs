// Local clone guard only. Never opens a PR, pushes or changes a branch.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function personalRepositorySettings(origin, upstream) {
  if (origin !== 'https://github.com/namidainfo/mixdog.git' ||
      upstream !== 'https://github.com/tribgames/mixdog.git') {
    throw new Error('Expected the personal Fork as origin and the original repository as upstream.');
  }
  return [
    ['remote.upstream.pushurl', 'DISABLED'],
    ['remote.pushDefault', 'origin'],
    ['branch.personal.pushRemote', 'origin'],
  ];
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git exited ${result.status}`);
  return result.stdout.trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const settings = personalRepositorySettings(git(['remote', 'get-url', 'origin']), git(['remote', 'get-url', 'upstream']));
  for (const [key, value] of settings) git(['config', key, value]);
  console.log('Personal Fork push target retained; upstream push disabled. No fetch, merge or push performed.');
}
