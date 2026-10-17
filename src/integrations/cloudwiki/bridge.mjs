import { spawn } from 'node:child_process';
import cloudwikiRunner from './runner.mjs';
export function runCloudWiki(action, input = {}) {
  if (!['status', 'submit'].includes(action)) return Promise.reject(new Error('CloudWiki 작업을 확인해 주세요.'));
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32' ? spawn('C:\\Windows\\System32\\wsl.exe', [
      '-d', 'Ubuntu', '-u', 'namidainfo', '--exec', 'bash', '-c',
      'export PATH="$HOME/.hermes/node/bin:$HOME/.local/bin:$PATH"; exec node --input-type=module -e "$1" -- --worktrail-cloudwiki',
      'worktrail-cloudwiki', cloudwikiRunner,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(process.execPath, ['--input-type=module', '-e', cloudwikiRunner, '--', '--worktrail-cloudwiki'],
        { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', diagnostic = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('CloudWiki 응답이 늦습니다. 같은 문서로 상태 확인·재시도해 주세요.')); }, action === 'submit' ? 75_000 : 30_000);
    child.on('error', () => finish(new Error('WSL CloudWiki 연결을 시작하지 못했습니다.')));
    child.stdin.on('error', () => finish(new Error('WSL CloudWiki 요청을 전달하지 못했습니다.')));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(0, 2_000); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 2_000_000) { child.kill(); finish(new Error('CloudWiki 응답 크기를 확인해 주세요.')); }
    });
    child.on('close', (code) => {
      if (settled) return;
      try {
        const receipt = JSON.parse(output);
        if (code !== 0 || receipt.error) finish(new Error(receipt.error || 'CloudWiki 연결에 실패했습니다.'));
        else if (!receipt.result) finish(new Error('CloudWiki 결과를 확인하지 못했습니다.'));
        else finish(undefined, receipt.result);
      } catch {
        const reason = diagnostic.trim().split(/\r?\n/u)[0]?.slice(0, 500);
        finish(new Error(`WSL CloudWiki 요청기 실행 실패 (${code ?? 'unknown'})${reason ? `: ${reason}` : '. 연결 결과를 확인하지 못했습니다.'}`));
      }
    });
    child.stdin.end(JSON.stringify({ action, input }));
  });
}
