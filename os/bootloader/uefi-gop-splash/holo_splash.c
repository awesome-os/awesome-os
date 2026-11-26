/* SPDX-License-Identifier: BSD-3-Clause */
/*
 * holo_splash.c — Freestanding C11 UEFI GOP & SimpleDRM 24-bit BMP Splash Blitter
 * Zero libc malloc/stdio dependencies; safe in UEFI, Limine, and Linux initramfs.
 */
#include "holo_splash.h"

static uint16_t rd_u16(const uint8_t *p)
{
	return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static uint32_t rd_u32(const uint8_t *p)
{
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
	       ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int32_t rd_i32(const uint8_t *p)
{
	return (int32_t)rd_u32(p);
}

static uint32_t pack_pixel(enum holo_pixel_format fmt, uint8_t r, uint8_t g, uint8_t b)
{
	if (fmt == HOLO_PIXFMT_RGBA8888) {
		return ((uint32_t)0xFFU << 24) | ((uint32_t)b << 16) |
		       ((uint32_t)g << 8) | (uint32_t)r;
	}
	/* HOLO_PIXFMT_BGRA8888 (UEFI GOP default) */
	return ((uint32_t)0xFFU << 24) | ((uint32_t)r << 16) |
	       ((uint32_t)g << 8) | (uint32_t)b;
}

int holo_splash_blit_bmp24(struct holo_framebuffer *fb,
			   const uint8_t *bmp_data,
			   size_t bmp_len,
			   uint32_t backdrop_rgb)
{
	if (!fb || !fb->pixels || fb->width == 0 || fb->height == 0 ||
	    fb->stride_pixels < fb->width || !bmp_data || bmp_len < 54) {
		return -1;
	}

	if (bmp_data[0] != 0x42 || bmp_data[1] != 0x4D)
		return -2; /* Not 'BM' */

	uint32_t data_off = rd_u32(bmp_data + 10);
	uint32_t dib_size = rd_u32(bmp_data + 14);
	int32_t raw_w = rd_i32(bmp_data + 18);
	int32_t raw_h = rd_i32(bmp_data + 22);
	uint16_t bpp = rd_u16(bmp_data + 28);
	uint32_t compression = rd_u32(bmp_data + 30);

	if (dib_size < 40 || raw_w <= 0 || raw_h == 0 || bpp != 24 || compression != 0)
		return -3; /* Require uncompressed 24-bit BI_RGB */

	uint32_t bmp_w = (uint32_t)raw_w;
	int bottom_up = raw_h > 0;
	uint32_t bmp_h = bottom_up ? (uint32_t)raw_h : (uint32_t)(-raw_h);
	size_t row_stride = ((size_t)bmp_w * 3U + 3U) & ~(size_t)3U;

	if (data_off > bmp_len || (size_t)bmp_h * row_stride > bmp_len - data_off)
		return -4; /* Truncated pixel array */

	uint32_t bg = pack_pixel(fb->format,
				 (uint8_t)((backdrop_rgb >> 16) & 0xFFU),
				 (uint8_t)((backdrop_rgb >> 8) & 0xFFU),
				 (uint8_t)(backdrop_rgb & 0xFFU));

	for (uint32_t y = 0; y < fb->height; ++y) {
		uint32_t *dst = fb->pixels + (size_t)y * fb->stride_pixels;
		for (uint32_t x = 0; x < fb->width; ++x)
			dst[x] = bg;
	}

	/* Nearest-neighbor centered blit (1:1 when sizes match, crisp scale otherwise) */
	for (uint32_t y = 0; y < fb->height; ++y) {
		uint32_t sy = (uint32_t)(((uint64_t)y * bmp_h) / fb->height);
		uint32_t src_row = bottom_up ? (bmp_h - 1U - sy) : sy;
		const uint8_t *src = bmp_data + data_off + (size_t)src_row * row_stride;
		uint32_t *dst = fb->pixels + (size_t)y * fb->stride_pixels;

		for (uint32_t x = 0; x < fb->width; ++x) {
			uint32_t sx = (uint32_t)(((uint64_t)x * bmp_w) / fb->width);
			const uint8_t *px = src + (size_t)sx * 3U;
			dst[x] = pack_pixel(fb->format, px[2], px[1], px[0]);
		}
	}

	return 0;
}

void holo_splash_draw_progress(struct holo_framebuffer *fb,
			       uint32_t percent,
			       uint32_t fill_rgb,
			       uint32_t track_rgb)
{
	if (!fb || !fb->pixels || fb->width < 16 || fb->height < 16)
		return;
	if (percent > 100U)
		percent = 100U;

	uint32_t min_dim = fb->width < fb->height ? fb->width : fb->height;
	uint32_t bar_w = (min_dim * 36U) / 100U;
	uint32_t bar_h = min_dim / 100U;
	if (bar_h < 4U)
		bar_h = 4U;

	uint32_t x0 = (fb->width - bar_w) / 2U;
	uint32_t y0 = (fb->height * 72U) / 100U;
	uint32_t fill_w = (bar_w * percent) / 100U;

	uint32_t fill_px = pack_pixel(fb->format,
				      (uint8_t)((fill_rgb >> 16) & 0xFFU),
				      (uint8_t)((fill_rgb >> 8) & 0xFFU),
				      (uint8_t)(fill_rgb & 0xFFU));
	uint32_t track_px = pack_pixel(fb->format,
				       (uint8_t)((track_rgb >> 16) & 0xFFU),
				       (uint8_t)((track_rgb >> 8) & 0xFFU),
				       (uint8_t)(track_rgb & 0xFFU));

	for (uint32_t dy = 0; dy < bar_h && (y0 + dy) < fb->height; ++dy) {
		uint32_t *dst = fb->pixels + (size_t)(y0 + dy) * fb->stride_pixels;
		for (uint32_t dx = 0; dx < bar_w && (x0 + dx) < fb->width; ++dx) {
			dst[x0 + dx] = (dx < fill_w) ? fill_px : track_px;
		}
	}
}
