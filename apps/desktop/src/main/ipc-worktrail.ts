import type { IpcHandle } from './ipc';
import { DESKTOP_IPC } from '../shared/contract';
import { createWorktrailService } from './worktrail-service';

export function registerWorktrailIpc(handle: IpcHandle, directory: () => string, enabled: boolean): void {
  let service: ReturnType<typeof createWorktrailService> | undefined;
  handle(DESKTOP_IPC.worktrailRequest, (_event, action, input) => {
    if (!enabled) throw new Error('Worktrail 문서화는 Mixdog Personal에서만 사용할 수 있습니다.');
    service ??= createWorktrailService({ directory: directory() }).catch(error => {
      service = undefined;
      throw error;
    });
    return service.then(current => current.invoke(action, input));
  });
}
