/**
 * @file src/workspaces.mts
 * @description Canonical `workspaces://` URI protocol resolver & materializer.
 * Hosts versioned VS Code / Code-OSS / Antigravity `.code-workspace` definitions
 * with `.vscode/settings.json`, `.vscode/extensions.json`, and `.vscode/mcp.json`
 * pre-wired to `holo-host-manager mcp` and `coli mcp`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkspaceDef {
  uri: string;
  org: string;
  name: string;
  displayName: string;
  description: string;
  profileUri: string;
  folders: Array<{ name: string; path: string; repositoryUri: string }>;
  settings: Record<string, unknown>;
  extensions: string[];
  mcpServers: Record<string, { command: string; args: string[] }>;
}

export const AWESOME_WORKSPACES: readonly WorkspaceDef[] = [
  {
    uri: 'workspaces://awesome-os/ai-colibri',
    org: 'awesome-os',
    name: 'ai-colibri',
    displayName: 'AI & Local LLM Engineering (Colibri + llama.cpp + vLLM)',
    description: 'Hierarchical MoE inference, Vulkan/CUDA/Metal/XDNA backends, LumiBERT 2.8ms auto-repair, and v11 CAS expert shards.',
    profileUri: 'system://profile/workstation-sectium',
    folders: [
      { name: 'colibri', path: './colibri', repositoryUri: 'repository://github.com/awesome-os/colibri@main' },
      { name: 'llama.cpp', path: './llama.cpp', repositoryUri: 'repository://github.com/awesome-os/llama.cpp@main' },
      { name: 'vllm', path: './vllm', repositoryUri: 'repository://github.com/awesome-os/vllm@main' },
      { name: 'host-manager', path: './host-manager', repositoryUri: 'repository://github.com/awesome-os/host-manager@main' },
    ],
    settings: {
      'workbench.colorTheme': 'Default Dark Modern',
      'editor.fontFamily': "'Cascadia Code', 'SF Mono', Consolas, monospace",
      'editor.formatOnSave': true,
      'files.eol': '\n',
      'awesome-os.casLayout': 'v11',
      'awesome-os.llm.defaultEngine': 'colibri',
      'awesome-os.llm.ipcPipe': '\\\\.\\pipe\\b8g-colibri',
    },
    extensions: [
      'llvm-vs-code-extensions.vscode-clangd',
      'biomejs.biome',
      'ms-python.python',
    ],
    mcpServers: {
      'awesome-os': { command: 'holo-host-manager', args: ['mcp'] },
      colibri: { command: 'coli', args: ['mcp'] },
    },
  },
  {
    uri: 'workspaces://awesome-os/os-dev',
    org: 'awesome-os',
    name: 'os-dev',
    displayName: 'Awesome-OS Core & Kernel Engineering',
    description: '4-layer Sectium/B8G stack, holo-compiler, desktop/posix triad, t2linux-baseline, and Ladybird C11 bridges.',
    profileUri: 'system://profile/workstation-omarchy',
    folders: [
      { name: 'desktop', path: './desktop', repositoryUri: 'repository://github.com/awesome-os/desktop@main' },
      { name: 'posix', path: './posix', repositoryUri: 'repository://github.com/awesome-os/posix@main' },
      { name: 't2linux-baseline', path: './t2linux-baseline', repositoryUri: 'repository://github.com/awesome-os/t2linux-baseline@main' },
      { name: 'ladybird', path: './ladybird', repositoryUri: 'repository://github.com/awesome-os/ladybird@main' },
      { name: 'holo-ffi', path: './holo-ffi', repositoryUri: 'repository://github.com/awesome-os/holo-ffi@main' },
    ],
    settings: {
      'workbench.colorTheme': 'Default Dark Modern',
      'editor.formatOnSave': true,
      'files.eol': '\n',
      'awesome-os.casLayout': 'v11',
      'awesome-os.abiMagic': '0x33564742',
    },
    extensions: [
      'llvm-vs-code-extensions.vscode-clangd',
      'biomejs.biome',
      'ziglang.vscode-zig',
    ],
    mcpServers: {
      'awesome-os': { command: 'holo-host-manager', args: ['mcp'] },
    },
  },
  {
    uri: 'workspaces://awesome-os/creator-studio',
    org: 'awesome-os',
    name: 'creator-studio',
    displayName: 'Creator & VTuber Studio (OBS Vertical + White Dragon + Sectium)',
    description: 'Zero-duplication streaming, 3D chromatic White Dragon VTuber rig, and Sectium Browser workspace.',
    profileUri: 'system://profile/workstation-noctalia',
    folders: [
      { name: 'desktop', path: './desktop', repositoryUri: 'repository://github.com/awesome-os/desktop@main' },
      { name: 'installer', path: './installer', repositoryUri: 'repository://github.com/awesome-os/installer@main' },
      { name: 'obs', path: './obs', repositoryUri: 'repository://github.com/awesome-os/obs@main' },
    ],
    settings: {
      'workbench.colorTheme': 'Default Dark Modern',
      'editor.formatOnSave': true,
      'awesome-os.casLayout': 'v11',
      'awesome-os.vtuber.mascot': 'lumi-white-dragon',
    },
    extensions: ['biomejs.biome'],
    mcpServers: {
      'awesome-os': { command: 'holo-host-manager', args: ['mcp'] },
    },
  },
];

export function parseWorkspaceUri(uri: string): { org: string; name: string } {
  const m = /^workspaces:\/\/([a-z0-9._-]+)\/([a-z0-9._-]+)$/i.exec(uri.trim());
  if (!m) {
    throw new Error(`Invalid workspaces:// URI: "${uri}". Expected workspaces://<org>/<name>`);
  }
  return { org: m[1], name: m[2] };
}

export function resolveWorkspace(uri: string): WorkspaceDef {
  const { org, name } = parseWorkspaceUri(uri);
  const found = AWESOME_WORKSPACES.find((w) => w.org === org && w.name === name);
  if (!found) {
    throw new Error(`Unknown workspace "${uri}". Available: ${AWESOME_WORKSPACES.map((w) => w.uri).join(', ')}`);
  }
  return found;
}

export function renderCodeWorkspaceJson(ws: WorkspaceDef): string {
  return JSON.stringify(
    {
      schema: 'awesome-os.code-workspace.v1',
      workspaceUri: ws.uri,
      profileUri: ws.profileUri,
      folders: ws.folders.map((f) => ({ name: f.name, path: f.path })),
      settings: ws.settings,
      extensions: { recommendations: ws.extensions },
    },
    null,
    2,
  ) + '\n';
}

export function materializeWorkspace(uri: string, outDir: string): {
  workspaceFile: string;
  mcpConfigFile: string;
  settingsFile: string;
  workspace: WorkspaceDef;
} {
  const ws = resolveWorkspace(uri);
  const vscodeDir = join(outDir, '.vscode');
  mkdirSync(vscodeDir, { recursive: true });

  const workspaceFile = join(outDir, `${ws.name}.code-workspace`);
  const settingsFile = join(vscodeDir, 'settings.json');
  const mcpConfigFile = join(vscodeDir, 'mcp.json');

  writeFileSync(workspaceFile, renderCodeWorkspaceJson(ws), 'utf8');
  writeFileSync(settingsFile, JSON.stringify(ws.settings, null, 2) + '\n', 'utf8');
  writeFileSync(
    mcpConfigFile,
    JSON.stringify({ servers: ws.mcpServers }, null, 2) + '\n',
    'utf8',
  );

  return { workspaceFile, mcpConfigFile, settingsFile, workspace: ws };
}
