/* SPDX-License-Identifier: BSD-3-Clause */
/* AwesomeOS Freestanding RISC-V 64 Microkernel Linker Script (OpenSBI @ 0x80200000) */
OUTPUT_ARCH(riscv)
ENTRY(_start)

SECTIONS
{
    . = 0x80200000;

    .text : ALIGN(4K) {
        KEEP(*(.text.boot))
        *(.text .text.*)
    }

    .rodata : ALIGN(4K) {
        *(.rodata .rodata.*)
    }

    .data : ALIGN(4K) {
        *(.data .data.*)
    }

    .bss : ALIGN(4K) {
        __bss_start = .;
        *(.bss .bss.* COMMON)
        . = ALIGN(16);
        __stack_bottom = .;
        . += 0x4000; /* 16 KiB S-Mode boot stack */
        __stack_top = .;
        __bss_end = .;
    }
}
