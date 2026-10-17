import path from 'node:path';
import { realpathSync } from 'node:fs';
import { normalizeToolName, parseToolArgs, isSelfMcpToolName } from './tool-primitives.mjs';
import { sensitive } from '../../integrations/slack-session/hub/files.mjs';

const approvals = new WeakMap();
const imageExtension = /\.(?:png|jpe?g|webp|gif)$/iu;
const pathsFor = (root) => /^[A-Za-z]:[\\/]/u.test(root) ? path.win32 : path;

export function normalizeSlackExecutionPolicy(value) {
  if (!value || value.version !== 1 || !/^T[A-Z0-9]+$/u.test(value.teamId || '')
    || !/^[UW][A-Z0-9]+$/u.test(value.userId || '')
    || typeof value.active !== 'boolean' || typeof value.admin !== 'boolean'
    || typeof value.root !== 'string' || value.root.includes('\0')
    || !pathsFor(value.root).isAbsolute(value.root) || /^(?:\\\\|\/\/)/u.test(value.root)) {
    throw new TypeError('유효한 Slack 실행 정책이 필요합니다.');
  }
  return Object.freeze({ version: 1, teamId: value.teamId, userId: value.userId,
    active: value.active, admin: value.admin, root: pathsFor(value.root).resolve(value.root) });
}

export function slackWorkspace(policy) {
  return pathsFor(policy.root).join(policy.root, 'slack-users', policy.teamId, policy.userId);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// A new output may have missing parents. Resolve its existing ancestor so a
// junction/symlink cannot turn a lexically private path into an external write.
function canonicalTarget(target) {
  try { return realpathSync(target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(canonicalTarget(parent), path.basename(target));
  }
}

export function isPrivateSlackPath(policy, value) {
  if (typeof value !== 'string' || !value || /[\0*?[\]]/u.test(value) || /^(?:\\\\|\/\/)/u.test(value)) return false;
  const target = path.resolve(policy.root, value), workspace = slackWorkspace(policy);
  const relative = path.relative(policy.root, target);
  if (!inside(workspace, target) || sensitive.test(relative)) return false;
  if (process.platform === 'win32' && (relative.includes(':')
    || relative.split(/[\\/]/u).some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)))) return false;
  try {
    const canonicalRoot = realpathSync(policy.root);
    const canonicalWorkspace = path.join(canonicalRoot, 'slack-users', policy.teamId, policy.userId);
    return inside(canonicalWorkspace, canonicalTarget(target));
  } catch { return false; }
}

function callArgs(call) {
  const raw = call.arguments ?? call.args;
  const parsed = typeof raw === 'string' ? parseToolArgs(raw) : raw;
  if (normalizeToolName(call.name) === 'visualize' && parsed?.input && typeof parsed.input === 'object') {
    const { input, ...outer } = parsed;
    return { ...input, ...outer };
  }
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function safeCall(policy, call) {
  const name = normalizeToolName(call.name), args = callArgs(call);
  if (['skill', 'skill_view', 'load_tool'].includes(name)) return true;
  if (name === 'read') {
    const entries = Array.isArray(args.file_path) ? args.file_path : [args.file_path];
    return entries.length > 0 && entries.every((entry) =>
      isPrivateSlackPath(policy, typeof entry === 'string' ? entry : entry?.file_path));
  }
  if (name === 'list') return isPrivateSlackPath(policy, args.path);
  if (name === 'media') {
    if (args.input !== undefined) return false;
    if (args.action === 'list') return true;
    return args.action === 'generate' && args.kind === 'image' && args.wait !== false
      && isPrivateSlackPath(policy, args.path) && imageExtension.test(args.path)
      && (args.references === undefined || (Array.isArray(args.references)
        && args.references.every((reference) => imageExtension.test(reference) && isPrivateSlackPath(policy, reference))));
  }
  if (name === 'visualize' && args.action === 'open') {
    return Object.keys(args).every((key) => ['action', 'targets', 'label'].includes(key))
      && Array.isArray(args.targets) && args.targets.length > 0
      && args.targets.every((target) => imageExtension.test(target) && isPrivateSlackPath(policy, target));
  }
  return false;
}

function signature(call) {
  return JSON.stringify([normalizeToolName(call.schemaName || call.name), callArgs(call)]);
}

// The approval handle is an in-process object, never a JSON flag a model can
// supply. Bind it to this session, policy revision and exact final call.
export function rememberSlackToolApproval(session, call) {
  approvals.set(call, { session, policy: session.slackExecutionPolicy, signature: signature(call) });
}

export function slackToolDecision(session, call, approvalHandle) {
  if (!session?.slackExecutionPolicy) return null;
  let policy;
  try { policy = normalizeSlackExecutionPolicy(session.slackExecutionPolicy); } catch {
    return { action: 'deny', reason: 'Slack 실행 정책이 손상되어 도구 실행을 차단했습니다.' };
  }
  if (!policy.active) return { action: 'deny', reason: 'Slack 사용자 승인이 해제되어 도구 실행을 차단했습니다.' };
  if (policy.admin) return null;
  if ([session.cwd, call.cwd].some((cwd) => cwd && path.relative(policy.root, cwd) !== '')) {
    return { action: 'deny', reason: 'Slack 작업 폴더가 실행 정책과 달라 도구 실행을 차단했습니다.' };
  }
  const name = normalizeToolName(call.name);
  if (['agent', 'setup', 'cwd', 'goal'].includes(name) || isSelfMcpToolName(call.name)) {
    return { action: 'deny', reason: '일반 Slack 사용자는 세션·권한·시스템 설정을 변경하거나 실행을 위임할 수 없습니다.' };
  }
  if (safeCall(policy, call)) return null;
  const approved = approvalHandle && approvals.get(approvalHandle);
  if (approved?.session === session && approved.policy === session.slackExecutionPolicy
    && approved.signature === signature(call)) {
    approvals.delete(approvalHandle);
    return null;
  }
  return { action: 'ask', reason: `Slack 일반 사용자 ${policy.teamId}:${policy.userId}의 요청입니다. `
    + `본인 산출물 폴더(${slackWorkspace(policy)}) 밖의 접근 또는 제한된 도구입니다. `
    + 'PC 소유자가 Mixdog 승인 화면에서 정확한 인자와 영향을 확인해야 합니다. Slack 본인 승인은 허용하지 않습니다.' };
}
