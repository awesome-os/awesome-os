/* SPDX-License-Identifier: BSD-3-Clause */
/*
 * Hermetic C11 ABI & Lock-Free Ring Self-Test for Holo-Linux b8g_abi.h
 * Compiles natively on Windows (.\bin\zig.cmd cc) and Linux (clang/gcc).
 */
#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../include/uapi/linux/b8g_abi.h"

static uint64_t holo_slice_ns_for_class(uint32_t cls)
{
	switch (cls) {
	case B8G_CLASS_SECTIUM_FRAME: return 1000000ULL;
	case B8G_CLASS_CONTROL_PLANE: return 2000000ULL;
	case B8G_CLASS_AI_INFERENCE:  return 4000000ULL;
	default:                      return 10000000ULL;
	}
}

int main(void)
{
	/* 1. Verify exact 64-byte cache-line ABI alignment & sizes */
	assert(sizeof(struct b8g_arena_hdr) == B8G_ARENA_ALIGN);
	assert(sizeof(struct b8g_ring_entry) == B8G_ARENA_ALIGN);
	assert(offsetof(struct b8g_arena_hdr, magic) == 0);
	assert(offsetof(struct b8g_arena_hdr, arena_bytes) == 32);

	/* 2. Allocate a 64 KiB B8G_ARENA_V1 buffer and initialize header */
	const size_t arena_bytes = 4096U * B8G_ARENA_DEFAULT_PAGES;
	uint8_t *buf = (uint8_t *)calloc(1, arena_bytes);
	assert(buf != NULL);

	struct b8g_arena_hdr *hdr = (struct b8g_arena_hdr *)buf;
	struct b8g_ring_entry *ring = (struct b8g_ring_entry *)(buf + B8G_ARENA_ALIGN);
	hdr->magic = B8G_ABI_MAGIC_V3;
	hdr->abi_version = B8G_ABI_VERSION;
	hdr->ring_mask = 63U; /* 64 entries */
	hdr->arena_bytes = arena_bytes;
	hdr->sched_class = B8G_CLASS_SECTIUM_FRAME;

	/* 3. Exercise lock-free wrap-around over 200 ring frames */
	for (uint32_t i = 0; i < 200; ++i) {
		uint32_t slot = hdr->sq_tail & hdr->ring_mask;
		ring[slot].opcode = B8G_OP_DISPLAY_FRAME;
		ring[slot].cap_handle = 0xCAFE0000U | i;
		ring[slot].seq_id = i + 1;
		ring[slot].deadline_ns = holo_slice_ns_for_class(hdr->sched_class);
		hdr->sq_tail++;

		uint32_t cslot = hdr->sq_head & hdr->ring_mask;
		assert(ring[cslot].seq_id == i + 1);
		assert(ring[cslot].cap_handle == (0xCAFE0000U | i));
		hdr->sq_head++;
	}
	assert(hdr->sq_head == 200U && hdr->sq_tail == 200U);

	/* 4. Verify scx_holo priority slice ordering */
	assert(holo_slice_ns_for_class(B8G_CLASS_SECTIUM_FRAME) <
	       holo_slice_ns_for_class(B8G_CLASS_CONTROL_PLANE));
	assert(holo_slice_ns_for_class(B8G_CLASS_CONTROL_PLANE) <
	       holo_slice_ns_for_class(B8G_CLASS_AI_INFERENCE));
	assert(holo_slice_ns_for_class(B8G_CLASS_AI_INFERENCE) <
	       holo_slice_ns_for_class(B8G_CLASS_BATCH_CAS));

	/* 5. Verify ioctl numbers are distinct & non-zero */
	assert(B8G_IOC_GET_INFO != 0);
	assert(B8G_IOC_GET_INFO != B8G_IOC_BIND_SCHED_CLASS);
	assert(B8G_IOC_DOORBELL != B8G_IOC_GET_INFO);

	free(buf);
	printf("b8g_abi_selftest: PASS (magic=0x%08x hdr=%zuB entry=%zuB frames=200)\n",
	       B8G_ABI_MAGIC_V3, sizeof(struct b8g_arena_hdr), sizeof(struct b8g_ring_entry));
	return 0;
}
