// SPDX-License-Identifier: GPL-2.0 OR BSD-3-Clause
/*
 * b8g_abi.ko — Holo-Linux 7.3.6 Zero-Copy B8G_ARENA_V1 Kernel Personality
 *
 * Exposes /dev/b8g-arena so userspace peers (sectium-cp, b8g-runtime,
 * host-manager, Colibri/vLLM) can mmap 64-byte aligned B8G_ABI_MAGIC_V3
 * shared rings and integrate with io_uring IORING_OP_POLL_ADD doorbells
 * without any local HTTP IPC (B8G016).
 */
#include <linux/fs.h>
#include <linux/miscdevice.h>
#include <linux/mm.h>
#include <linux/module.h>
#include <linux/poll.h>
#include <linux/sched.h>
#include <linux/slab.h>
#include <linux/uaccess.h>
#include <linux/vmalloc.h>
#include <linux/wait.h>

#include "../include/uapi/linux/b8g_abi.h"

struct b8g_arena_ctx {
	void *arena_mem;
	size_t arena_bytes;
	u32 ring_entries;
	u32 sched_class;
	u64 last_seen_seq;
	wait_queue_head_t wq;
};

static int b8g_open(struct inode *inode, struct file *filp)
{
	struct b8g_arena_ctx *ctx;
	struct b8g_arena_hdr *hdr;
	size_t bytes = PAGE_SIZE * B8G_ARENA_DEFAULT_PAGES;

	ctx = kzalloc(sizeof(*ctx), GFP_KERNEL);
	if (!ctx)
		return -ENOMEM;

	ctx->arena_mem = vmalloc_user(bytes);
	if (!ctx->arena_mem) {
		kfree(ctx);
		return -ENOMEM;
	}

	ctx->arena_bytes = bytes;
	ctx->ring_entries = 64;
	ctx->sched_class = B8G_CLASS_DEFAULT;
	init_waitqueue_head(&ctx->wq);

	hdr = (struct b8g_arena_hdr *)ctx->arena_mem;
	hdr->magic = B8G_ABI_MAGIC_V3;
	hdr->abi_version = B8G_ABI_VERSION;
	hdr->ring_mask = ctx->ring_entries - 1;
	hdr->arena_bytes = bytes;
	hdr->owner_pid = task_tgid_vnr(current);
	hdr->sched_class = ctx->sched_class;

	filp->private_data = ctx;
	return 0;
}

static int b8g_release(struct inode *inode, struct file *filp)
{
	struct b8g_arena_ctx *ctx = filp->private_data;

	if (ctx) {
		vfree(ctx->arena_mem);
		kfree(ctx);
	}
	return 0;
}

static int b8g_mmap(struct file *filp, struct vm_area_struct *vma)
{
	struct b8g_arena_ctx *ctx = filp->private_data;
	unsigned long size = vma->vm_end - vma->vm_start;

	if (size > ctx->arena_bytes)
		return -EINVAL;

	return remap_vmalloc_range(vma, ctx->arena_mem, vma->vm_pgoff);
}

static __poll_t b8g_poll(struct file *filp, poll_table *wait)
{
	struct b8g_arena_ctx *ctx = filp->private_data;
	struct b8g_arena_hdr *hdr = (struct b8g_arena_hdr *)ctx->arena_mem;

	poll_wait(filp, &ctx->wq, wait);
	if (READ_ONCE(hdr->doorbell_seq) != ctx->last_seen_seq) {
		ctx->last_seen_seq = READ_ONCE(hdr->doorbell_seq);
		return EPOLLIN | EPOLLRDNORM;
	}
	return 0;
}

static long b8g_ioctl(struct file *filp, unsigned int cmd, unsigned long arg)
{
	struct b8g_arena_ctx *ctx = filp->private_data;
	struct b8g_arena_hdr *hdr = (struct b8g_arena_hdr *)ctx->arena_mem;

	switch (cmd) {
	case B8G_IOC_GET_INFO: {
		struct b8g_arena_info info = {
			.magic = B8G_ABI_MAGIC_V3,
			.abi_version = B8G_ABI_VERSION,
			.arena_bytes = ctx->arena_bytes,
			.ring_entries = ctx->ring_entries,
			.sched_class = ctx->sched_class,
		};
		if (copy_to_user((void __user *)arg, &info, sizeof(info)))
			return -EFAULT;
		return 0;
	}
	case B8G_IOC_BIND_SCHED_CLASS: {
		struct b8g_sched_hint hint;

		if (copy_from_user(&hint, (void __user *)arg, sizeof(hint)))
			return -EFAULT;
		if (hint.sched_class > B8G_CLASS_BATCH_CAS)
			return -EINVAL;
		ctx->sched_class = hint.sched_class;
		WRITE_ONCE(hdr->sched_class, hint.sched_class);
		return 0;
	}
	case B8G_IOC_DOORBELL:
		WRITE_ONCE(hdr->doorbell_seq, READ_ONCE(hdr->doorbell_seq) + 1);
		wake_up_interruptible(&ctx->wq);
		return 0;
	default:
		return -ENOTTY;
	}
}

static const struct file_operations b8g_fops = {
	.owner          = THIS_MODULE,
	.open           = b8g_open,
	.release        = b8g_release,
	.mmap           = b8g_mmap,
	.poll           = b8g_poll,
	.unlocked_ioctl = b8g_ioctl,
};

static struct miscdevice b8g_miscdev = {
	.minor = MISC_DYNAMIC_MINOR,
	.name  = "b8g-arena",
	.fops  = &b8g_fops,
	.mode  = 0660,
};

static int __init b8g_abi_init(void)
{
	pr_info("b8g_abi: registering /dev/b8g-arena (magic=0x%08x v%u)\n",
		B8G_ABI_MAGIC_V3, B8G_ABI_VERSION);
	return misc_register(&b8g_miscdev);
}

static void __exit b8g_abi_exit(void)
{
	misc_deregister(&b8g_miscdev);
	pr_info("b8g_abi: unregistered /dev/b8g-arena\n");
}

module_init(b8g_abi_init);
module_exit(b8g_abi_exit);

MODULE_LICENSE("Dual BSD/GPL");
MODULE_AUTHOR("Awesome-OS Kernel Team");
MODULE_DESCRIPTION("Holo-Linux B8G_ABI_MAGIC_V3 zero-copy arena personality");
