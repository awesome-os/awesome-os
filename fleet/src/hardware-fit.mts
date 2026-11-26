/**
 * @file src/hardware-fit.mts
 * @description Colibri-inspired hardware probe & "Fits My Machine" recommender
 * for Awesome-OS workstation profiles and local LLM engines (Colibri, llama.cpp, vLLM).
 */

import { statfsSync } from 'node:fs';
import { arch, cpus, freemem, hostname, platform, totalmem } from 'node:os';
import { SYSTEM_PROFILES } from './profiles-and-driver-sets.mts';

export interface HardwareProbe {
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  memoryTotalGb: number;
  memoryFreeGb: number;
  diskFreeGb: number;
  targetDir: string;
  summary: string;
}

export interface FitRecommendation {
  id: string;
  kind: 'os-profile' | 'llm-engine';
  displayName: string;
  ramMinGb: number;
  ramGoodGb: number;
  diskMinGb: number;
  status: 'good' | 'tight' | 'needs-ram' | 'needs-disk';
  fits: boolean;
  recommended: boolean;
  reason: string;
  tier: 'gpu-vram' | 'ram-resident' | 'nvme-stream' | 'minimal-headless';
}

export function detectHardware(targetDir = process.cwd()): HardwareProbe {
  const cpuList = cpus();
  const totalGb = Number((totalmem() / (1024 ** 3)).toFixed(2));
  const freeGb = Number((freemem() / (1024 ** 3)).toFixed(2));
  let diskFreeGb = 64;
  try {
    const st = statfsSync(targetDir);
    diskFreeGb = Number(((st.bavail * st.bsize) / (1024 ** 3)).toFixed(2));
  } catch {
    diskFreeGb = 64;
  }

  const cpuModel = cpuList[0]?.model?.trim() || `${arch()} CPU`;
  const summary = `${cpuList.length} cores (${cpuModel}), ${totalGb} GB RAM (${freeGb} GB free), ${diskFreeGb} GB free disk on ${platform()}/${arch()}`;

  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    cpuModel,
    cpuCores: cpuList.length,
    memoryTotalGb: totalGb,
    memoryFreeGb: freeGb,
    diskFreeGb,
    targetDir,
    summary,
  };
}

function evaluateFit(
  hw: HardwareProbe,
  ramMinGb: number,
  ramGoodGb: number,
  diskMinGb: number,
): { status: FitRecommendation['status']; fits: boolean; reason: string } {
  if (hw.memoryTotalGb < ramMinGb) {
    return { status: 'needs-ram', fits: false, reason: `Needs >= ${ramMinGb} GB RAM (machine has ${hw.memoryTotalGb} GB)` };
  }
  if (hw.diskFreeGb < diskMinGb) {
    return { status: 'needs-disk', fits: false, reason: `Needs >= ${diskMinGb} GB free disk (available: ${hw.diskFreeGb} GB)` };
  }
  if (hw.memoryTotalGb < ramGoodGb) {
    return { status: 'tight', fits: true, reason: `Fits in RAM (${hw.memoryTotalGb} GB); ${ramGoodGb} GB recommended for peak headroom` };
  }
  return { status: 'good', fits: true, reason: `Smooth fit on ${hw.cpuCores}-core ${hw.memoryTotalGb} GB machine` };
}

export function recommendProfilesAndModels(hw: HardwareProbe = detectHardware()): FitRecommendation[] {
  const osItems: FitRecommendation[] = SYSTEM_PROFILES.map((p) => {
    const isHeadless = p.defaultSurface === 'terminal';
    const ramMin = isHeadless ? 0.5 : 2;
    const ramGood = isHeadless ? 2 : 8;
    const diskMin = isHeadless ? 0.5 : 4;
    const fit = evaluateFit(hw, ramMin, ramGood, diskMin);
    return {
      id: p.uri,
      kind: 'os-profile',
      displayName: p.displayName,
      ramMinGb: ramMin,
      ramGoodGb: ramGood,
      diskMinGb: diskMin,
      ...fit,
      recommended: p.id === 'workstation-omarchy' && fit.fits,
      tier: isHeadless ? 'minimal-headless' : 'ram-resident',
    };
  });

  const llmSpecs: Array<{
    id: string;
    displayName: string;
    ramMinGb: number;
    ramGoodGb: number;
    diskMinGb: number;
    tier: FitRecommendation['tier'];
  }> = [
    { id: 'llm://colibri/qwen36-35b', displayName: 'Colibri — Qwen3.6-35B-A3B (RAM / Vulkan)', ramMinGb: 10, ramGoodGb: 20, diskMinGb: 24, tier: 'ram-resident' },
    { id: 'llm://colibri/glm-5.2-744b', displayName: 'Colibri — GLM-5.2 744B MoE (NVMe Stream)', ramMinGb: 16, ramGoodGb: 32, diskMinGb: 430, tier: 'nvme-stream' },
    { id: 'llm://llama.cpp/gguf-local', displayName: 'llama.cpp — Universal GGUF Server', ramMinGb: 4, ramGoodGb: 16, diskMinGb: 8, tier: 'ram-resident' },
    { id: 'llm://vllm/paged-attention', displayName: 'vLLM — Multi-GPU PagedAttention Serving', ramMinGb: 16, ramGoodGb: 64, diskMinGb: 30, tier: 'gpu-vram' },
  ];

  const llmItems: FitRecommendation[] = llmSpecs.map((m) => {
    const fit = evaluateFit(hw, m.ramMinGb, m.ramGoodGb, m.diskMinGb);
    return {
      ...m,
      kind: 'llm-engine',
      ...fit,
      recommended: false,
    };
  });

  const bestLlm = llmItems.find((m) => m.id === 'llm://colibri/qwen36-35b' && m.fits)
    ?? llmItems.find((m) => m.fits);
  if (bestLlm) bestLlm.recommended = true;

  return [...osItems, ...llmItems];
}
