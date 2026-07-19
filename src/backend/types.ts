import type {
  CommandResult,
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

/** 沙箱数据面后端：fake 内存或生产集群 API */
export interface SandboxBackend {
  readonly kind: SandboxBackendKind;
  create(req: CreateSandboxBackendRequest): Promise<BackendSandboxHandle>;
  get(remoteId: string): Promise<BackendSandboxHandle | null>;
  kill(remoteId: string): Promise<void>;
  runCommand(
    remoteId: string,
    input: {
      cmd: string;
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
    },
  ): Promise<CommandResult>;
  writeFile(
    remoteId: string,
    path: string,
    data: Uint8Array | string,
  ): Promise<void>;
  readFile(remoteId: string, path: string): Promise<Uint8Array>;
  listFiles(remoteId: string, path?: string): Promise<FileEntry[]>;
}
