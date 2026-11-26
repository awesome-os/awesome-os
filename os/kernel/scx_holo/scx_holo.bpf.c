/* SPDX-License-Identifier: GPL-2.0 OR BSD-3-Clause */
/*
 * scx_holo.bpf.c — Holo-Linux 7.3.6 sched_ext BPF Scheduler
 *
 * Class-aware dispatch without patching kernel/sched/:
 *   1. B8G_CLASS_SECTIUM_FRAME -> HOLO_DSQ_FRAME (1 ms slice, display deadline)
 *   2. B8G_CLASS_CONTROL_PLANE -> HOLO_DSQ_CTRL  (2 ms slice, sectium-cp)
 *   3. B8G_CLASS_AI_INFERENCE  -> HOLO_DSQ_AI    (4 ms slice, Colibri/vLLM)
 *   4. B8G_CLASS_BATCH_CAS     -> SCX_DSQ_GLOBAL (10 ms slice, holo-compiler)
 *
 * Safely falls back to Linux EEVDF automatically if unloaded or watchdog trips.
 */
#include <scx/common.bpf.h>
#include "../include/uapi/linux/b8g_abi.h"

char _license[] SEC("license") = "GPL";

#define HOLO_DSQ_FRAME 100
#define HOLO_DSQ_CTRL  101
#define HOLO_DSQ_AI    102

#define HOLO_SLICE_FRAME_NS (1ULL * 1000 * 1000)
#define HOLO_SLICE_CTRL_NS  (2ULL * 1000 * 1000)
#define HOLO_SLICE_AI_NS    (4ULL * 1000 * 1000)
#define HOLO_SLICE_BATCH_NS (10ULL * 1000 * 1000)

struct holo_task_ctx {
	__u32 sched_class;
	__u32 deadline_us;
};

struct {
	__uint(type, BPF_MAP_TYPE_TASK_STORAGE);
	__uint(map_flags, BPF_F_NO_PREALLOC);
	__type(key, int);
	__type(value, struct holo_task_ctx);
} holo_task_map SEC(".maps");

s32 BPF_STRUCT_OPS(holo_select_cpu, struct task_struct *p, s32 prev_cpu, u64 wake_flags)
{
	bool is_idle = false;
	s32 cpu = scx_bpf_select_cpu_dfl(p, prev_cpu, wake_flags, &is_idle);

	if (is_idle) {
		scx_bpf_dsq_insert(p, SCX_DSQ_LOCAL, HOLO_SLICE_FRAME_NS, 0);
	}
	return cpu;
}

void BPF_STRUCT_OPS(holo_enqueue, struct task_struct *p, u64 enq_flags)
{
	struct holo_task_ctx *tctx = bpf_task_storage_get(&holo_task_map, p, 0, 0);
	__u32 cls = tctx ? tctx->sched_class : B8G_CLASS_DEFAULT;

	switch (cls) {
	case B8G_CLASS_SECTIUM_FRAME:
		scx_bpf_dsq_insert(p, HOLO_DSQ_FRAME, HOLO_SLICE_FRAME_NS, enq_flags);
		break;
	case B8G_CLASS_CONTROL_PLANE:
		scx_bpf_dsq_insert(p, HOLO_DSQ_CTRL, HOLO_SLICE_CTRL_NS, enq_flags);
		break;
	case B8G_CLASS_AI_INFERENCE:
		scx_bpf_dsq_insert(p, HOLO_DSQ_AI, HOLO_SLICE_AI_NS, enq_flags);
		break;
	default:
		scx_bpf_dsq_insert(p, SCX_DSQ_GLOBAL, HOLO_SLICE_BATCH_NS, enq_flags);
		break;
	}
}

void BPF_STRUCT_OPS(holo_dispatch, s32 cpu, struct task_struct *prev)
{
	if (scx_bpf_dsq_move_to_local(HOLO_DSQ_FRAME))
		return;
	if (scx_bpf_dsq_move_to_local(HOLO_DSQ_CTRL))
		return;
	if (scx_bpf_dsq_move_to_local(HOLO_DSQ_AI))
		return;
	scx_bpf_dsq_move_to_local(SCX_DSQ_GLOBAL);
}

s32 BPF_STRUCT_OPS_SLEEPABLE(holo_init)
{
	s32 ret;

	ret = scx_bpf_create_dsq(HOLO_DSQ_FRAME, -1);
	if (ret)
		return ret;
	ret = scx_bpf_create_dsq(HOLO_DSQ_CTRL, -1);
	if (ret)
		return ret;
	return scx_bpf_create_dsq(HOLO_DSQ_AI, -1);
}

SCX_OPS_DEFINE(holo_ops,
	       .select_cpu = (void *)holo_select_cpu,
	       .enqueue    = (void *)holo_enqueue,
	       .dispatch   = (void *)holo_dispatch,
	       .init       = (void *)holo_init,
	       .name       = "scx_holo");
