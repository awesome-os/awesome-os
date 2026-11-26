#ifndef B8G_ES_H
#define B8G_ES_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define B8G_ES_VERSION "0.1.0"

typedef struct B8gEsVm B8gEsVm;

/* Create a new zero-dependency C11 ECMAScript VM instance. */
B8gEsVm *b8g_es_create(void);

/* Evaluate UTF-8 ECMAScript source code.
 * Returns 0 on success, non-zero on syntax or runtime error.
 * If out_buf != NULL and out_cap > 0, writes the string representation
 * of the final expression value (or empty string if undefined). */
int b8g_es_eval(B8gEsVm *vm, const char *source, const char *filename,
                char *out_buf, size_t out_cap);

/* Destroy VM and free all associated memory. */
void b8g_es_destroy(B8gEsVm *vm);

/* Return the last error message (empty string if no error). */
const char *b8g_es_last_error(const B8gEsVm *vm);

/* Return non-zero if console.log printed output during the last eval. */
int b8g_es_did_print(const B8gEsVm *vm);

#ifdef __cplusplus
}
#endif

#endif /* B8G_ES_H */
