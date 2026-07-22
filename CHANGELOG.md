# Changelog

本文件遵循 Keep a Changelog；版本约定见 [f2b-meta RELEASE.md](https://github.com/f2b-dev/f2b-meta/blob/main/RELEASE.md)。

## [Unreleased]

### Added

- 容量与 reaper 字段回显于 `/healthz`
- 契约 CI（`ci:contract`）与 GHA 端口/DB 隔离
- `smoke:cube-http`：经 `/v1` 验收 `backend=cube`（mock 或真集群）；`ci:contract` 已串 mock 路径

### Fixed

- GHA workflow step 名含未加引号 `file:` 导致 YAML 解析失败

## [0.1.0] - 2026-07

- 产品 `/v1`：生命周期、命令（含 SSE）、文件、模板、用量、API Key
- Fake 数据面；可选 `F2B_CUBE_*` 真数据面 adapter
