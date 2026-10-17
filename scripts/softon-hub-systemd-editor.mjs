import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Called only by systemctl --user edit; systemd owns atomic installation.
export async function stageHubOverride(source, targets, home = os.homedir()) {
  // systemctl edit supplies the initial cursor line before its temporary file.
  if (targets.length === 2 && /^\+\d+$/u.test(targets[0])) targets = targets.slice(1);
  if (targets.length !== 1) throw new Error('Exactly one SOFTON hub override must be edited.');
  const text = await fs.readFile(source, 'utf8'), lines = text.trim().split(/\r?\n/u);
  const keys = ['MIXDOG_HUB_ORIGIN', 'MIXDOG_HUB_ADMINS', 'MIXDOG_HUB_TLS_KEY', 'MIXDOG_HUB_TLS_CERT'];
  const found = lines.slice(1).map((line) => /^Environment="(MIXDOG_HUB_(?:ORIGIN|ADMINS|TLS_KEY|TLS_CERT))=[^"\r\n]*"$/u.exec(line)?.[1]);
  if (lines[0] !== '[Service]' || found.length !== keys.length || new Set(found).size !== keys.length
    || found.some((name) => !keys.includes(name))) throw new Error('Only the four approved SOFTON hub settings may be staged.');
  const directory = path.join(home, '.config/systemd/user/codex-slack-bridge.service.d');
  const target = path.resolve(targets[0]);
  if (await fs.realpath(path.dirname(target)) !== await fs.realpath(directory)
    || !/^(?:\.#)?95-softon-session-hub\.conf[.a-zA-Z0-9_-]*$/u.test(path.basename(target))) {
    throw new Error('The editor target is not the SOFTON hub service override.');
  }
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The staged override must be a regular file.');
  await fs.writeFile(target, text, { encoding: 'utf8' });
  await fs.chmod(target, 0o600);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  stageHubOverride(process.argv[2], process.argv.slice(3)).catch((error) => {
    console.error(error.message); process.exitCode = 1;
  });
}
