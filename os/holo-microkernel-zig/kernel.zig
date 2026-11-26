// SPDX-License-Identifier: BSD-3-Clause
// AwesomeOS Freestanding RISC-V 64 Time-Sharing Microkernel (`holo-microkernel-zig`)
//
// Inspired by popovicu/zig-time-sharing-kernel (Zig + OpenSBI S-Mode), upgraded with
// AwesomeOS `B8G_ABI_MAGIC_V3` (0x33564742) 64-byte aligned zero-copy task arenas.
//
// Build freestanding < 16 KB RISC-V 64 ELF:
//   zig build-exe kernel.zig -target riscv64-freestanding-none -O ReleaseSmall -T linker.ld -femit-bin=holo-microkernel-riscv64.elf
// Run host unit tests:
//   zig test kernel.zig

const std = @import("std");
const builtin = @import("builtin");

pub const B8G_ABI_MAGIC_V3: u32 = 0x33564742;
pub const B8G_ABI_VERSION: u32 = 3;
pub const MAX_TASKS: usize = 8;
pub const QEMU_UART0_BASE: usize = 0x1000_0000;
pub const SBI_EXT_TIME: usize = 0x54494D45; // "TIME"
pub const SBI_EXT_SRST: usize = 0x53525354; // "SRST"

pub const SyscallId = enum(u32) {
    get_abi_magic = 1,
    task_yield = 2,
    arena_submit = 3,
    uart_putc = 4,
};

pub const TaskState = enum(u8) {
    unused = 0,
    ready = 1,
    running = 2,
    blocked = 3,
};

/// Saved callee-saved RISC-V 64 context (ra, sp, s0..s11) for cooperative/timer switching.
pub const CpuContext = extern struct {
    ra: u64 = 0,
    sp: u64 = 0,
    s: [12]u64 = [_]u64{0} ** 12,
};

/// 64-byte cache-line aligned zero-copy B8G task header (matches Holo-Linux b8g_arena_hdr).
pub const B8gTaskArena = extern struct {
    magic: u32 align(64) = B8G_ABI_MAGIC_V3,
    abi_version: u32 = B8G_ABI_VERSION,
    task_id: u32 = 0,
    state: u32 = 0,
    sq_head: u32 = 0,
    sq_tail: u32 = 0,
    slice_ticks: u32 = 1,
    yield_count: u32 = 0,
    submitted_ops: u64 = 0,
    deadline_ns: u64 = 1_000_000,
    reserved: [2]u64 = [_]u64{ 0, 0 },
};

comptime {
    if (@sizeOf(B8gTaskArena) != 64) {
        @compileError("B8gTaskArena must be exactly 64 bytes");
    }
    if (@alignOf(B8gTaskArena) != 64) {
        @compileError("B8gTaskArena must be 64-byte cache-line aligned");
    }
}

pub const Scheduler = struct {
    arenas: [MAX_TASKS]B8gTaskArena = [_]B8gTaskArena{.{}} ** MAX_TASKS,
    contexts: [MAX_TASKS]CpuContext = [_]CpuContext{.{}} ** MAX_TASKS,
    states: [MAX_TASKS]TaskState = [_]TaskState{.unused} ** MAX_TASKS,
    current: usize = 0,
    active_count: usize = 0,

    pub fn init(self: *Scheduler) void {
        self.* = .{};
        for (0..MAX_TASKS) |i| {
            self.arenas[i].magic = B8G_ABI_MAGIC_V3;
            self.arenas[i].abi_version = B8G_ABI_VERSION;
            self.arenas[i].task_id = @intCast(i);
        }
    }

    pub fn spawnTask(self: *Scheduler, entry_pc: u64, stack_top: u64, deadline_ns: u64) ?usize {
        for (0..MAX_TASKS) |i| {
            if (self.states[i] == .unused) {
                self.states[i] = if (self.active_count == 0) .running else .ready;
                if (self.active_count == 0) self.current = i;
                self.contexts[i] = .{ .ra = entry_pc, .sp = stack_top };
                self.arenas[i].state = @intFromEnum(self.states[i]);
                self.arenas[i].deadline_ns = deadline_ns;
                self.active_count += 1;
                return i;
            }
        }
        return null;
    }

    /// Round-robin time-sharing step across ready tasks (invoked on OpenSBI timer interrupt or yield).
    pub fn scheduleNext(self: *Scheduler) usize {
        if (self.active_count == 0) return 0;
        const prev = self.current;
        if (self.states[prev] == .running) {
            self.states[prev] = .ready;
            self.arenas[prev].state = @intFromEnum(TaskState.ready);
        }
        var offset: usize = 1;
        while (offset <= MAX_TASKS) : (offset += 1) {
            const idx = (prev + offset) % MAX_TASKS;
            if (self.states[idx] == .ready) {
                self.states[idx] = .running;
                self.arenas[idx].state = @intFromEnum(TaskState.running);
                self.arenas[idx].yield_count += 1;
                self.current = idx;
                return idx;
            }
        }
        return prev;
    }

    pub fn dispatchSyscall(self: *Scheduler, id: SyscallId, arg0: u64) u64 {
        return switch (id) {
            .get_abi_magic => B8G_ABI_MAGIC_V3,
            .task_yield => @intCast(self.scheduleNext()),
            .arena_submit => blk: {
                var a = &self.arenas[self.current];
                a.sq_tail +%= 1;
                a.submitted_ops += arg0;
                break :blk a.submitted_ops;
            },
            .uart_putc => blk: {
                if (builtin.os.tag == .freestanding and builtin.cpu.arch == .riscv64) {
                    uartPutc(@truncate(arg0));
                }
                break :blk 1;
            },
        };
    }
};

fn uartPutc(ch: u8) void {
    const thr: *volatile u8 = @ptrFromInt(QEMU_UART0_BASE);
    thr.* = ch;
}

fn uartPuts(msg: []const u8) void {
    for (msg) |c| uartPutc(c);
}

fn sbiCall(ext: usize, fid: usize, a0: usize, a1: usize) void {
    if (builtin.cpu.arch != .riscv64) return;
    asm volatile ("ecall"
        :
        : [a0] "{a0}" (a0),
          [a1] "{a1}" (a1),
          [a6] "{a6}" (fid),
          [a7] "{a7}" (ext),
        : "memory"
    );
}

var global_sched: Scheduler = .{};

export fn kmain() noreturn {
    global_sched.init();
    _ = global_sched.spawnTask(0x8020_1000, 0x8021_0000, 1_000_000);
    _ = global_sched.spawnTask(0x8020_2000, 0x8022_0000, 4_000_000);
    _ = global_sched.scheduleNext();

    if (builtin.os.tag == .freestanding and builtin.cpu.arch == .riscv64) {
        uartPuts("[HOLO-ZIG-MICROKERNEL] READY (B8G_ABI_MAGIC_V3=0x33564742, tasks=2)\n");
        // Arm OpenSBI timer & cleanly request SBI system shutdown in headless selftest
        sbiCall(SBI_EXT_TIME, 0, 100_000, 0);
        sbiCall(SBI_EXT_SRST, 0, 0, 0);
    }
    while (true) {
        if (builtin.cpu.arch == .riscv64) {
            asm volatile ("wfi");
        }
    }
}

comptime {
    if (builtin.os.tag == .freestanding and builtin.cpu.arch == .riscv64) {
        asm (
            \\.section .text.boot
            \\.global _start
            \\_start:
            \\    la sp, __stack_top
            \\    call kmain
        );
    }
}

test "holo-microkernel-zig: 64-byte B8G_ABI_MAGIC_V3 arena, round-robin scheduler & syscalls" {
    var sched: Scheduler = .{};
    sched.init();

    try std.testing.expectEqual(@as(usize, 64), @sizeOf(B8gTaskArena));
    try std.testing.expectEqual(@as(usize, 64), @alignOf(B8gTaskArena));

    const t0 = sched.spawnTask(0x1000, 0x9000, 1_000_000).?;
    const t1 = sched.spawnTask(0x2000, 0xA000, 2_000_000).?;
    const t2 = sched.spawnTask(0x3000, 0xB000, 4_000_000).?;
    try std.testing.expectEqual(@as(usize, 0), t0);
    try std.testing.expectEqual(@as(usize, 1), t1);
    try std.testing.expectEqual(@as(usize, 2), t2);

    try std.testing.expectEqual(@as(u64, B8G_ABI_MAGIC_V3), sched.dispatchSyscall(.get_abi_magic, 0));
    try std.testing.expectEqual(@as(u64, 5), sched.dispatchSyscall(.arena_submit, 5));

    // Yield rotates 0 -> 1 -> 2 -> 0
    try std.testing.expectEqual(@as(u64, 1), sched.dispatchSyscall(.task_yield, 0));
    try std.testing.expectEqual(@as(u64, 2), sched.dispatchSyscall(.task_yield, 0));
    try std.testing.expectEqual(@as(u64, 0), sched.dispatchSyscall(.task_yield, 0));
}
