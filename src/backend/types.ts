import type {
  CommandResult,
  CommandStreamEvent,
  CreateSandboxInput,
  FileEntry,
  SandboxBackendKind,
  SandboxStatus,
} from "@f2b/spec";

export type CreateSandboxBackendRequest = CreateSandboxInput & {
  sandboxId: string;
};

export type BackendSandboxHandle = {
  sandboxId: string;
  remoteId: string;
  backend: SandboxBackendKind;
  status: SandboxStatus;
};

export type RunCommandInput = {
  cmd: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
};

/** 沙箱数据面后端：fake 内存或生产集群 API */
export interface SandboxBackend {
  readonly kind: SandboxBackendKind;
  create(req: CreateSandboxBackendRequest): Promise<BackendSandboxHandle>;
  get(remoteId: string): Promise<BackendSandboxHandle | null>;
  kill(remoteId: string): Promise<void>;
  runCommand(
    remoteId: string,
    input: RunCommandInput,
  ): Promise<CommandResult>;
  /**
   * 可选流式命令。未实现时服务层用 runCommand 结果拆成 stdout/stderr/result 事件。
   */
  streamCommand?(
    remoteId: string,
    input: RunCommandInput,
  ): AsyncIterable<CommandStreamEvent>;
  writeFile(
    remoteId: string,
    path: string,
    data: Uint8Array | string,
  ): Promise<void>;
  readFile(remoteId: string, path: string): Promise<Uint8Array>;
  listFiles(remoteId: string, path?: string): Promise<FileEntry[]>;
}
