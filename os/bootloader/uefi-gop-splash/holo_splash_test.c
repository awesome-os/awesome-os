/* SPDX-License-Identifier: BSD-3-Clause */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

#include "holo_splash.h"

static uint8_t *load_file(const char *path, size_t *out_len)
{
	FILE *f = fopen(path, "rb");
	assert(f != NULL);
	assert(fseek(f, 0, SEEK_END) == 0);
	long sz = ftell(f);
	assert(sz > 54);
	assert(fseek(f, 0, SEEK_SET) == 0);
	uint8_t *buf = (uint8_t *)malloc((size_t)sz);
	assert(buf != NULL);
	assert(fread(buf, 1, (size_t)sz, f) == (size_t)sz);
	fclose(f);
	*out_len = (size_t)sz;
	return buf;
}

int main(void)
{
	size_t bmp_len = 0;
	uint8_t *bmp = load_file("assets/splash/awesome-os-640x480.bmp", &bmp_len);

	uint32_t *pixels = (uint32_t *)calloc(640U * 480U, sizeof(uint32_t));
	assert(pixels != NULL);

	struct holo_framebuffer fb = {
		.pixels = pixels,
		.width = 640,
		.height = 480,
		.stride_pixels = 640,
		.format = HOLO_PIXFMT_BGRA8888,
	};

	assert(holo_splash_blit_bmp24(&fb, bmp, bmp_len, 0x0E1116U) == 0);
	/* Top-left corner must match dark graphite backdrop (alpha=0xFF) */
	assert((pixels[0] >> 24) == 0xFFU);
	assert(((pixels[0] >> 16) & 0xFFU) < 32U);

	/* Update progress bar to 100% Lumi Cyan (#39C5CF) */
	holo_splash_draw_progress(&fb, 100, 0x39C5CFU, 0x242B36U);
	uint32_t bar_px = pixels[(480U * 72U / 100U) * 640U + 320U];
	assert(bar_px == 0xFF39C5CFU);

	/* Reject invalid BMP magic */
	bmp[0] = 'X';
	assert(holo_splash_blit_bmp24(&fb, bmp, bmp_len, 0x0E1116U) == -2);

	free(pixels);
	free(bmp);
	printf("holo_splash_test: PASS (640x480 BGRA8888 UEFI GOP blit + progress rail)\n");
	return 0;
}
