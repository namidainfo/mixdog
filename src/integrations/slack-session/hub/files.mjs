import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const inside = (root, value) => {
  const relative = path.relative(root, value);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};
export const sensitive = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.git|\.ssh|\.mixdog|\.codex|\.claude)(?:[\\/]|$)|\.(?:pem|key|p12|pfx)$/iu;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export class HubFiles {
  constructor(root) { this.root = path.resolve(root); this.manifests = new Map(); }
  async read(target, { metadataOnlyLarge = false } = {}) {
    const root = await fs.realpath(this.root), absolute = path.resolve(this.root, target);
    if (!inside(this.root, absolute) || sensitive.test(path.relative(this.root, absolute))) throw new Error('허용되지 않은 파일 경로입니다.');
    const real = await fs.realpath(absolute);
    if (!inside(root, real) || sensitive.test(path.relative(root, real))) throw new Error('프로젝트 외부 또는 보호된 파일입니다.');
    const handle = await fs.open(real, 'r');
    try {
      const stat = await handle.stat(), current = await fs.stat(real);
      if (!stat.isFile() || stat.ino !== current.ino || stat.dev !== current.dev) {
        throw new Error('파일 종류·크기 또는 변경 상태를 확인해 주세요.');
      }
      if (stat.size > MAX_FILE_BYTES) {
        if (metadataOnlyLarge) return { size: stat.size, modifiedAt: stat.mtime.toISOString(), downloadable: false };
        throw new Error('파일이 용량 제한을 초과했습니다.');
      }
      const data = await handle.readFile();
      if (data.length > MAX_FILE_BYTES) throw new Error('파일이 용량 제한을 초과했습니다.');
      return { data, size: data.length, modifiedAt: stat.mtime.toISOString(), sha256: digest(data) };
    } finally { await handle.close(); }
  }
  async snapshot(sessionId, paths) {
    const manifest = new Map(), rows = [];
    for (const target of paths) {
      try {
        const value = await this.read(target, { metadataOnlyLarge: true });
        const relative = path.relative(this.root, path.resolve(this.root, target)).split(path.sep).join('/');
        const id = digest(`${sessionId}\0${relative}`);
        if (value.downloadable !== false) manifest.set(id, { target, sha256: value.sha256 });
        rows.push({ id, path: relative, size: value.size, modifiedAt: value.modifiedAt, sha256: value.sha256,
          downloadable: value.downloadable !== false });
      } catch (error) {
        if (error.code !== 'ENOENT' && !/허용되지|보호된|프로젝트 외부|파일 종류|용량 제한/u.test(error.message)) throw error;
      }
    }
    this.manifests.set(sessionId, manifest); return rows;
  }
  async file(sessionId, fileId, sha256) {
    const file = this.manifests.get(sessionId)?.get(fileId);
    if (!file) throw new Error('이 세션의 산출물이 아닙니다. 스냅샷을 갱신해 주세요.');
    if (sha256 !== file.sha256) throw new Error('파일 버전이 다릅니다. 스냅샷을 갱신해 주세요.');
    const current = await this.read(file.target);
    if (current.sha256 !== file.sha256) throw new Error('갱신 후 파일이 변경됐습니다. 스냅샷을 다시 확인해 주세요.');
    return { data: current.data.toString('base64') };
  }
}
