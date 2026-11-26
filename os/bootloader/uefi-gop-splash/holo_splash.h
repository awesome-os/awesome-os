/* SPDX-License-Identifier: BSD-3-Clause */
/*
 * holo_splash.h — Zero-Flicker UEFI GOP / Linux SimpleDRM Framebuffer Splash Blitter
 */
#ifndef HOLO_SPLASH_H
#define HOLO_SPLASH_H

#include <stddef.h>
#include <stdint.h>

enum holo_pixel_format {
	HOLO_PIXFMT_BGRA8888 = 0, /* Standard UEFI GOP PixelBlueGreenRedReserved8BitPerColor */
	HOLO_PIXFMT_RGBA8888 = 1, /* PixelRedGreenBlueReserved8BitPerColor */
};

struct holo_framebuffer {
	uint32_t *pixels;
	uint32_t width;
	uint32_t height;
	uint32_t stride_pixels; /* Pixels per scanline (>= width) */
	enum holo_pixel_format format;
};

/*
 * Validates an uncompressed 24-bit BI_RGB BMP and blits it centered onto `fb`
 * (filling any letterbox area with `backdrop_rgb`). Returns 0 on success, < 0 on error.
 */
int holo_splash_blit_bmp24(struct holo_framebuffer *fb,
			   const uint8_t *bmp_data,
			   size_t bmp_len,
			   uint32_t backdrop_rgb);

/*
 * Renders a deterministic progress bar (0..100%) on the lower rail without touching
 * the rest of the splash screen (zero-flicker boot feedback).
 */
void holo_splash_draw_progress(struct holo_framebuffer *fb,
			       uint32_t percent,
			       uint32_t fill_rgb,
			       uint32_t track_rgb);

#endif /* HOLO_SPLASH_H */
