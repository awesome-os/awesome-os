/* SPDX-License-Identifier: (GPL-2.0 WITH Linux-syscall-note) OR BSD-3-Clause */
/*
 * Holo-Linux 7.3.6 — B8G_ABI_MAGIC_V3 Zero-Copy Arena & sched_ext UAPI
 *
 * Shared contract between:
 *   - kernel/b8g_abi/b8g_abi.c       (/dev/b8g-arena)
 *   - kernel/scx_holo/scx_holo.bpf.c (sched_ext BPF scheduler)
 *   - sectium-cloud-control-plane    (5 KB C11 PID 1 initramfs)
 *   - b8g-runtime / host-manager     (userspace zero-copy peers)
 */
#ifndef _UAPI_LINUX_B8G_ABI_H
#define _UAPI_LINUX_B8G_ABI_H

#ifdef __KERNEL__
#include <linux/ioctl.h>
#include <linux/types.h>
#else
#include <stdint.h>
typedef uint8_t  __u8;
typedef uint16_t __u16;
typedef uint32_t __u32;
typedef uint64_t __u64;
#ifndef _IOC
#define _IOC(dir, type, nr, size) \
	(((dir) << 30) | ((size) << 16) | ((type) << 8) | (nr))
#define _IO(type, nr)         _IOC(0U, (type), (nr), 0U)
#define _IOW(type, nr, sz)    _IOC(1U, (type), (nr), (unsigned int)sizeof(sz))
#define _IOR(type, nr, sz)    _IOC(2U, (type), (nr), (unsigned int)sizeof(sz))
#endif
#endif

/* Canonical B8G ABI v3 magic ("B8G3" little-endian) */
#define B8G_ABI_MAGIC_V3          0x33564742U
#define B8G_ABI_VERSION           3U
#define B8G_ARENA_ALIGN           64U
#define B8G_ARENA_DEFAULT_PAGES   16U /* 64 KiB default zero-copy arena */

/* Workload scheduling classes consumed by scx_holo (sched_ext) */
enum b8g_sched_class {
	B8G_CLASS_DEFAULT       = 0,
	B8G_CLASS_SECTIUM_FRAME = 1, /* 120/240Hz pure-art display deadline (1 ms slice) */
	B8G_CLASS_AI_INFERENCE  = 2, /* Colibri / llama.cpp / vLLM GPU/NPU feeder (4 ms) */
	B8G_CLASS_CONTROL_PLANE = 3, /* sectium-cp discovery & WoL checkpointing (2 ms) */
	B8G_CLASS_BATCH_CAS     = 4, /* holo-compiler / v11 CAS packing (10 ms) */
};

/* Ring opcodes for zero-copy B8G_ARENA_V1 entries */
enum b8g_ring_opcode {
	B8G_OP_NOP           = 0,
	B8G_OP_PEER_SEND     = 1,
	B8G_OP_DISPLAY_FRAME = 2,
	B8G_OP_CAS_FETCH     = 3,
	B8G_OP_WOL_SNAPSHOT  = 4,
};

/*
 * 64-byte cache-line aligned arena header at offset 0 of /dev/b8g-arena mmap.
 */
struct b8g_arena_hdr {
	__u32 magic;        /* B8G_ABI_MAGIC_V3 */
	__u32 abi_version;  /* B8G_ABI_VERSION  */
	__u32 flags;
	__u32 ring_mask;    /* power-of-two capacity - 1 */
	__u32 sq_head;      /* consumer index */
	__u32 sq_tail;      /* producer index */
	__u32 cq_head;      /* completion consumer index */
	__u32 cq_tail;      /* completion producer index */
	__u64 arena_bytes;  /* total mapped bytes */
	__u32 owner_pid;
	__u32 sched_class;  /* enum b8g_sched_class */
	__u64 doorbell_seq; /* monotonic wake counter */
	__u64 reserved;
};

/*
 * 64-byte cache-line aligned ring descriptor (SQE / CQE).
 */
struct b8g_ring_entry {
	__u16 opcode;       /* enum b8g_ring_opcode */
	__u16 flags;
	__u32 cap_handle;   /* capability token (Mach/seL4-inspired handle) */
	__u64 peer_id;      /* opaque peer mux id */
	__u64 payload_off;  /* offset inside arena */
	__u32 payload_len;
	__u32 status;
	__u64 seq_id;
	__u64 deadline_ns;  /* monotonic frame/inference deadline */
	__u64 tag[2];       /* 128-bit v11 CAS prefix or correlation id */
};

struct b8g_arena_info {
	__u32 magic;
	__u32 abi_version;
	__u64 arena_bytes;
	__u32 ring_entries;
	__u32 sched_class;
};

struct b8g_sched_hint {
	__u32 sched_class;  /* enum b8g_sched_class */
	__u32 deadline_us;  /* target latency budget in microseconds */
};

#define B8G_IOC_MAGIC             'B'
#define B8G_IOC_GET_INFO          _IOR(B8G_IOC_MAGIC, 1, struct b8g_arena_info)
#define B8G_IOC_BIND_SCHED_CLASS  _IOW(B8G_IOC_MAGIC, 2, struct b8g_sched_hint)
#define B8G_IOC_DOORBELL          _IO(B8G_IOC_MAGIC, 3)

#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(sizeof(struct b8g_arena_hdr) == 64, "b8g_arena_hdr must be 64 bytes");
_Static_assert(sizeof(struct b8g_ring_entry) == 64, "b8g_ring_entry must be 64 bytes");
#endif

#endif /* _UAPI_LINUX_B8G_ABI_H */
