import { app } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

// Run before the runtime imports resolve data paths. Only the separately
// branded personal package activates this profile; official builds are unchanged.
if (app.isPackaged && app.getName() === 'mixdog-personal') {
  for (const key of Object.keys(process.env)) {
    if (/^MIXDOG_/i.test(key)) delete process.env[key];
  }
  if (process.platform === 'win32') {
    // Keep the existing roots and add Windows trust before any TLS connections.
    setDefaultCACertificates([...getCACertificates('default'), ...getCACertificates('system')]);
    // Detached daemons inherit this setting and apply it at process startup.
    process.env.NODE_USE_SYSTEM_CA = '1';
  }
  const profile = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'mixdog-dev', 'personal');
  Object.assign(process.env, {
    MIXDOG_PERSONAL: '1',
    MIXDOG_OAUTH_TLS_DIAGNOSTICS: '0',
    MIXDOG_DESKTOP_USER_DATA: profile,
    MIXDOG_HOME: join(profile, 'home'),
    MIXDOG_DATA_DIR: join(profile, 'data'),
    MIXDOG_RUNTIME_ROOT: join(profile, 'runtime'),
    MIXDOG_BRIDGE_DISCOVERY_DIR: join(profile, 'bridges'),
    MIXDOG_PROJECTS_FILE: join(profile, 'projects.json'),
    MIXDOG_DISABLE_PROJECT_MARKERS: '1',
  });
}
