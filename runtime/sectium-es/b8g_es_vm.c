#define _POSIX_C_SOURCE 200809L

#include "b8g_es.h"

#include <ctype.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <time.h>
#endif

/* =========================================================================
 * Arena Allocator (for AST nodes and parser strings)
 * ========================================================================= */

#define ARENA_CHUNK_SIZE (64 * 1024)

typedef struct ArenaChunk {
    struct ArenaChunk *next;
    size_t used;
    size_t cap;
    unsigned char data[];
} ArenaChunk;

typedef struct {
    ArenaChunk *head;
} Arena;

static void *arena_alloc(Arena *a, size_t size) {
    size = (size + 7u) & ~7u;
    if (!a->head || a->head->used + size > a->head->cap) {
        size_t cap = size > ARENA_CHUNK_SIZE ? size : ARENA_CHUNK_SIZE;
        ArenaChunk *c = (ArenaChunk *)malloc(sizeof(ArenaChunk) + cap);
        if (!c) return NULL;
        c->next = a->head;
        c->used = 0;
        c->cap = cap;
        a->head = c;
    }
    void *p = a->head->data + a->head->used;
    a->head->used += size;
    memset(p, 0, size);
    return p;
}

static char *arena_strndup(Arena *a, const char *s, size_t len) {
    char *p = (char *)arena_alloc(a, len + 1);
    if (!p) return NULL;
    memcpy(p, s, len);
    p[len] = '\0';
    return p;
}

static void arena_free(Arena *a) {
    ArenaChunk *c = a->head;
    while (c) {
        ArenaChunk *next = c->next;
        free(c);
        c = next;
    }
    a->head = NULL;
}

/* =========================================================================
 * Runtime Values & Heap Objects
 * ========================================================================= */

typedef enum {
    VAL_UNDEFINED = 0,
    VAL_NULL,
    VAL_BOOL,
    VAL_NUM,
    VAL_STR,
    VAL_ARR,
    VAL_OBJ,
    VAL_U8ARR,
    VAL_FN,
    VAL_NATIVE
} ValKind;

typedef enum {
    HEAP_STR = 1,
    HEAP_ARR,
    HEAP_OBJ,
    HEAP_U8ARR,
    HEAP_FN
} HeapKind;

typedef struct HeapObj {
    HeapKind kind;
    struct HeapObj *next;
} HeapObj;

typedef struct EsStr EsStr;
typedef struct EsArr EsArr;
typedef struct EsObj EsObj;
typedef struct EsU8Arr EsU8Arr;
typedef struct EsFn EsFn;
typedef struct EsEnv EsEnv;
typedef struct EsVal EsVal;
typedef struct Stmt Stmt;

typedef EsVal (*EsNativeFn)(B8gEsVm *vm, EsVal this_val, int argc, EsVal *argv);

struct EsVal {
    ValKind kind;
    union {
        bool b;
        double n;
        EsStr *s;
        EsArr *a;
        EsObj *o;
        EsU8Arr *u;
        EsFn *f;
        EsNativeFn native;
    } as;
};

struct EsStr {
    HeapObj hdr;
    size_t len;
    char *data;
};

struct EsArr {
    HeapObj hdr;
    size_t len;
    size_t cap;
    EsVal *items;
};

typedef struct {
    char *key;
    EsVal val;
} EsProp;

struct EsObj {
    HeapObj hdr;
    size_t len;
    size_t cap;
    EsProp *props;
};

struct EsU8Arr {
    HeapObj hdr;
    size_t len;
    uint8_t *data;
};

struct EsFn {
    HeapObj hdr;
    const char *name;
    int param_count;
    const char **params;
    Stmt *body;
    EsEnv *closure;
};

typedef struct {
    const char *name;
    EsVal val;
    bool is_const;
} EsBinding;

#define ENV_INLINE_CAP 8

struct EsEnv {
    EsEnv *parent;
    int refcount;
    size_t len;
    size_t cap;
    EsBinding *slots;
    EsBinding inline_slots[ENV_INLINE_CAP];
    EsEnv *free_next;
};

typedef enum {
    SIG_NONE = 0,
    SIG_RETURN,
    SIG_BREAK,
    SIG_CONTINUE,
    SIG_ERROR
} SignalKind;

struct B8gEsVm {
    Arena ast_arena;
    HeapObj *heap_head;
    EsEnv *global_env;
    EsEnv *free_envs;
    SignalKind signal;
    EsVal signal_val;
    int did_print;
    int call_depth;
    char error[512];
};

static inline EsVal val_undef(void) { EsVal v; v.kind = VAL_UNDEFINED; v.as.n = 0.0; return v; }
static inline EsVal val_null(void) { EsVal v; v.kind = VAL_NULL; v.as.n = 0.0; return v; }
static inline EsVal val_bool(bool b) { EsVal v; v.kind = VAL_BOOL; v.as.b = b; return v; }
static inline EsVal val_num(double n) { EsVal v; v.kind = VAL_NUM; v.as.n = n; return v; }
static inline EsVal val_str(EsStr *s) { EsVal v; v.kind = VAL_STR; v.as.s = s; return v; }
static inline EsVal val_arr(EsArr *a) { EsVal v; v.kind = VAL_ARR; v.as.a = a; return v; }
static inline EsVal val_obj(EsObj *o) { EsVal v; v.kind = VAL_OBJ; v.as.o = o; return v; }
static inline EsVal val_u8(EsU8Arr *u) { EsVal v; v.kind = VAL_U8ARR; v.as.u = u; return v; }
static inline EsVal val_fn(EsFn *f) { EsVal v; v.kind = VAL_FN; v.as.f = f; return v; }
static inline EsVal val_native(EsNativeFn fn) { EsVal v; v.kind = VAL_NATIVE; v.as.native = fn; return v; }

static void vm_error(B8gEsVm *vm, const char *fmt, ...) {
    if (vm->signal == SIG_ERROR) return;
    vm->signal = SIG_ERROR;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(vm->error, sizeof(vm->error), fmt, ap);
    va_end(ap);
}

static char *es_strdup_heap(const char *s, size_t len) {
    char *p = (char *)malloc(len + 1);
    if (!p) return NULL;
    memcpy(p, s, len);
    p[len] = '\0';
    return p;
}

static EsStr *new_str_len(B8gEsVm *vm, const char *s, size_t len) {
    EsStr *o = (EsStr *)malloc(sizeof(EsStr));
    if (!o) { vm_error(vm, "out of memory"); return NULL; }
    o->hdr.kind = HEAP_STR;
    o->hdr.next = vm->heap_head;
    vm->heap_head = &o->hdr;
    o->len = len;
    o->data = es_strdup_heap(s ? s : "", len);
    if (!o->data) { vm_error(vm, "out of memory"); return NULL; }
    return o;
}

static EsStr *new_str(B8gEsVm *vm, const char *s) {
    return new_str_len(vm, s, s ? strlen(s) : 0);
}

static EsArr *new_arr(B8gEsVm *vm, size_t cap) {
    EsArr *a = (EsArr *)malloc(sizeof(EsArr));
    if (!a) { vm_error(vm, "out of memory"); return NULL; }
    a->hdr.kind = HEAP_ARR;
    a->hdr.next = vm->heap_head;
    vm->heap_head = &a->hdr;
    a->len = 0;
    a->cap = cap < 4 ? 4 : cap;
    a->items = (EsVal *)malloc(sizeof(EsVal) * a->cap);
    if (!a->items) { vm_error(vm, "out of memory"); return NULL; }
    return a;
}

static void arr_push(B8gEsVm *vm, EsArr *a, EsVal v) {
    if (a->len >= a->cap) {
        size_t ncap = a->cap ? a->cap * 2 : 4;
        EsVal *ni = (EsVal *)realloc(a->items, sizeof(EsVal) * ncap);
        if (!ni) { vm_error(vm, "out of memory"); return; }
        a->items = ni;
        a->cap = ncap;
    }
    a->items[a->len++] = v;
}

static EsObj *new_obj(B8gEsVm *vm) {
    EsObj *o = (EsObj *)malloc(sizeof(EsObj));
    if (!o) { vm_error(vm, "out of memory"); return NULL; }
    o->hdr.kind = HEAP_OBJ;
    o->hdr.next = vm->heap_head;
    vm->heap_head = &o->hdr;
    o->len = 0;
    o->cap = 0;
    o->props = NULL;
    return o;
}

static bool obj_get(EsObj *o, const char *key, EsVal *out) {
    for (size_t i = 0; i < o->len; i++) {
        if (strcmp(o->props[i].key, key) == 0) {
            *out = o->props[i].val;
            return true;
        }
    }
    return false;
}

static void obj_set(B8gEsVm *vm, EsObj *o, const char *key, EsVal val) {
    for (size_t i = 0; i < o->len; i++) {
        if (strcmp(o->props[i].key, key) == 0) {
            o->props[i].val = val;
            return;
        }
    }
    if (o->len >= o->cap) {
        size_t ncap = o->cap ? o->cap * 2 : 4;
        EsProp *np = (EsProp *)realloc(o->props, sizeof(EsProp) * ncap);
        if (!np) { vm_error(vm, "out of memory"); return; }
        o->props = np;
        o->cap = ncap;
    }
    o->props[o->len].key = es_strdup_heap(key, strlen(key));
    o->props[o->len].val = val;
    o->len++;
}

static EsU8Arr *new_u8arr(B8gEsVm *vm, size_t len) {
    EsU8Arr *u = (EsU8Arr *)malloc(sizeof(EsU8Arr));
    if (!u) { vm_error(vm, "out of memory"); return NULL; }
    u->hdr.kind = HEAP_U8ARR;
    u->hdr.next = vm->heap_head;
    vm->heap_head = &u->hdr;
    u->len = len;
    u->data = (uint8_t *)calloc(len ? len : 1, 1);
    if (!u->data) { vm_error(vm, "out of memory"); return NULL; }
    return u;
}

static void env_retain(EsEnv *e) {
    if (e) e->refcount++;
}

static void env_release(B8gEsVm *vm, EsEnv *e) {
    while (e) {
        e->refcount--;
        if (e->refcount > 0) return;
        EsEnv *parent = e->parent;
        if (e->slots != e->inline_slots) {
            free(e->slots);
        }
        e->slots = e->inline_slots;
        e->cap = ENV_INLINE_CAP;
        e->len = 0;
        e->parent = NULL;
        e->free_next = vm->free_envs;
        vm->free_envs = e;
        e = parent;
    }
}

static EsEnv *env_new(B8gEsVm *vm, EsEnv *parent) {
    EsEnv *e = vm->free_envs;
    if (e) {
        vm->free_envs = e->free_next;
    } else {
        e = (EsEnv *)malloc(sizeof(EsEnv));
        if (!e) { vm_error(vm, "out of memory"); return NULL; }
    }
    e->parent = parent;
    env_retain(parent);
    e->refcount = 1;
    e->len = 0;
    e->cap = ENV_INLINE_CAP;
    e->slots = e->inline_slots;
    e->free_next = NULL;
    return e;
}

static void env_define(B8gEsVm *vm, EsEnv *e, const char *name, EsVal val, bool is_const) {
    for (size_t i = 0; i < e->len; i++) {
        if (strcmp(e->slots[i].name, name) == 0) {
            e->slots[i].val = val;
            e->slots[i].is_const = is_const;
            return;
        }
    }
    if (e->len >= e->cap) {
        size_t ncap = e->cap * 2;
        EsBinding *ns;
        if (e->slots == e->inline_slots) {
            ns = (EsBinding *)malloc(sizeof(EsBinding) * ncap);
            if (!ns) { vm_error(vm, "out of memory"); return; }
            memcpy(ns, e->inline_slots, sizeof(EsBinding) * e->len);
        } else {
            ns = (EsBinding *)realloc(e->slots, sizeof(EsBinding) * ncap);
            if (!ns) { vm_error(vm, "out of memory"); return; }
        }
        e->slots = ns;
        e->cap = ncap;
    }
    e->slots[e->len].name = name;
    e->slots[e->len].val = val;
    e->slots[e->len].is_const = is_const;
    e->len++;
}

static EsBinding *env_lookup(EsEnv *e, const char *name) {
    while (e) {
        for (size_t i = 0; i < e->len; i++) {
            if (strcmp(e->slots[i].name, name) == 0) {
                return &e->slots[i];
            }
        }
        e = e->parent;
    }
    return NULL;
}

static EsFn *new_fn(B8gEsVm *vm, const char *name, int param_count, const char **params,
                    Stmt *body, EsEnv *closure) {
    EsFn *f = (EsFn *)malloc(sizeof(EsFn));
    if (!f) { vm_error(vm, "out of memory"); return NULL; }
    f->hdr.kind = HEAP_FN;
    f->hdr.next = vm->heap_head;
    vm->heap_head = &f->hdr;
    f->name = name;
    f->param_count = param_count;
    f->params = params;
    f->body = body;
    f->closure = closure;
    env_retain(closure);
    return f;
}

/* =========================================================================
 * Value Conversions & Formatting
 * ========================================================================= */

static bool val_truthy(EsVal v) {
    switch (v.kind) {
        case VAL_UNDEFINED:
        case VAL_NULL:
            return false;
        case VAL_BOOL:
            return v.as.b;
        case VAL_NUM:
            return v.as.n != 0.0 && !isnan(v.as.n);
        case VAL_STR:
            return v.as.s->len > 0;
        default:
            return true;
    }
}

static double val_to_num(EsVal v) {
    switch (v.kind) {
        case VAL_NUM: return v.as.n;
        case VAL_BOOL: return v.as.b ? 1.0 : 0.0;
        case VAL_NULL: return 0.0;
        case VAL_UNDEFINED: return NAN;
        case VAL_STR: {
            if (v.as.s->len == 0) return 0.0;
            char *end = NULL;
            double d = strtod(v.as.s->data, &end);
            while (end && isspace((unsigned char)*end)) end++;
            if (end && *end == '\0') return d;
            return NAN;
        }
        default: return NAN;
    }
}

static int32_t val_to_i32(EsVal v) {
    double d = val_to_num(v);
    if (isnan(d) || isinf(d) || d == 0.0) return 0;
    return (int32_t)(int64_t)d;
}

static void format_num(double n, char *buf, size_t cap) {
    if (isnan(n)) {
        snprintf(buf, cap, "NaN");
    } else if (isinf(n)) {
        snprintf(buf, cap, n < 0 ? "-Infinity" : "Infinity");
    } else if (n == 0.0) {
        snprintf(buf, cap, "0");
    } else {
        double i = floor(n);
        if (i == n && fabs(n) < 9007199254740992.0) {
            snprintf(buf, cap, "%.0f", n);
        } else {
            snprintf(buf, cap, "%.15g", n);
        }
    }
}

static EsStr *val_to_str(B8gEsVm *vm, EsVal v) {
    char buf[128];
    switch (v.kind) {
        case VAL_UNDEFINED: return new_str(vm, "undefined");
        case VAL_NULL:      return new_str(vm, "null");
        case VAL_BOOL:      return new_str(vm, v.as.b ? "true" : "false");
        case VAL_NUM:
            format_num(v.as.n, buf, sizeof(buf));
            return new_str(vm, buf);
        case VAL_STR:
            return v.as.s;
        case VAL_ARR: {
            size_t cap = 64, len = 0;
            char *out = (char *)malloc(cap);
            if (!out) { vm_error(vm, "out of memory"); return NULL; }
            out[len++] = '[';
            for (size_t i = 0; i < v.as.a->len; i++) {
                if (i > 0) {
                    if (len + 2 >= cap) { cap *= 2; out = (char *)realloc(out, cap); }
                    out[len++] = ',';
                    out[len++] = ' ';
                }
                EsStr *es = val_to_str(vm, v.as.a->items[i]);
                if (!es) { free(out); return NULL; }
                while (len + es->len + 4 >= cap) { cap *= 2; out = (char *)realloc(out, cap); }
                memcpy(out + len, es->data, es->len);
                len += es->len;
            }
            out[len++] = ']';
            out[len] = '\0';
            EsStr *res = new_str_len(vm, out, len);
            free(out);
            return res;
        }
        case VAL_OBJ:
            return new_str(vm, "[object Object]");
        case VAL_U8ARR: {
            snprintf(buf, sizeof(buf), "Uint8Array(%zu)", v.as.u->len);
            return new_str(vm, buf);
        }
        case VAL_FN:
        case VAL_NATIVE:
            return new_str(vm, "[Function]");
    }
    return new_str(vm, "undefined");
}

static bool val_strict_eq(EsVal a, EsVal b) {
    if (a.kind != b.kind) return false;
    switch (a.kind) {
        case VAL_UNDEFINED:
        case VAL_NULL:
            return true;
        case VAL_BOOL:
            return a.as.b == b.as.b;
        case VAL_NUM:
            return a.as.n == b.as.n;
        case VAL_STR:
            return a.as.s->len == b.as.s->len &&
                   memcmp(a.as.s->data, b.as.s->data, a.as.s->len) == 0;
        case VAL_ARR: return a.as.a == b.as.a;
        case VAL_OBJ: return a.as.o == b.as.o;
        case VAL_U8ARR: return a.as.u == b.as.u;
        case VAL_FN: return a.as.f == b.as.f;
        case VAL_NATIVE: return a.as.native == b.as.native;
    }
    return false;
}

static bool val_loose_eq(EsVal a, EsVal b) {
    if (a.kind == b.kind) return val_strict_eq(a, b);
    if ((a.kind == VAL_NULL && b.kind == VAL_UNDEFINED) ||
        (a.kind == VAL_UNDEFINED && b.kind == VAL_NULL)) {
        return true;
    }
    if (a.kind == VAL_NUM || b.kind == VAL_NUM ||
        a.kind == VAL_BOOL || b.kind == VAL_BOOL) {
        return val_to_num(a) == val_to_num(b);
    }
    return false;
}

/* =========================================================================
 * Lexer
 * ========================================================================= */

typedef enum {
    TOK_EOF = 0,
    TOK_NUM,
    TOK_STR,
    TOK_IDENT,
    /* Keywords */
    TOK_LET, TOK_CONST, TOK_VAR, TOK_FUNCTION,
    TOK_IF, TOK_ELSE, TOK_WHILE, TOK_FOR,
    TOK_RETURN, TOK_BREAK, TOK_CONTINUE,
    TOK_TRUE, TOK_FALSE, TOK_NULL, TOK_UNDEFINED,
    TOK_NEW, TOK_TYPEOF,
    /* Punctuators & Operators */
    TOK_LPAREN, TOK_RPAREN, TOK_LBRACE, TOK_RBRACE,
    TOK_LBRACKET, TOK_RBRACKET,
    TOK_SEMI, TOK_COMMA, TOK_DOT, TOK_COLON, TOK_QUESTION,
    TOK_PLUS, TOK_MINUS, TOK_STAR, TOK_SLASH, TOK_PERCENT,
    TOK_ASSIGN, TOK_PLUS_EQ, TOK_MINUS_EQ, TOK_STAR_EQ, TOK_SLASH_EQ, TOK_PERCENT_EQ,
    TOK_INC, TOK_DEC,
    TOK_EQ, TOK_NEQ, TOK_SEQ, TOK_SNEQ,
    TOK_LT, TOK_LE, TOK_GT, TOK_GE,
    TOK_AND, TOK_OR, TOK_NOT,
    TOK_BIT_AND, TOK_BIT_OR, TOK_BIT_XOR, TOK_BIT_NOT,
    TOK_SHL, TOK_SHR
} TokKind;

typedef struct {
    TokKind kind;
    const char *start;
    size_t len;
    double num;
    char *str;
    size_t str_len;
    int line;
    bool had_newline;
} Token;

typedef struct {
    B8gEsVm *vm;
    const char *src;
    size_t pos;
    int line;
    Token cur;
    Token prev;
    bool has_error;
} Parser;

static bool is_ident_start(char c) {
    return isalpha((unsigned char)c) || c == '_' || c == '$';
}

static bool is_ident_part(char c) {
    return isalnum((unsigned char)c) || c == '_' || c == '$';
}

static TokKind check_keyword(const char *s, size_t len) {
    if (len == 2 && memcmp(s, "if", 2) == 0) return TOK_IF;
    if (len == 3) {
        if (memcmp(s, "let", 3) == 0) return TOK_LET;
        if (memcmp(s, "var", 3) == 0) return TOK_VAR;
        if (memcmp(s, "for", 3) == 0) return TOK_FOR;
        if (memcmp(s, "new", 3) == 0) return TOK_NEW;
    } else if (len == 4) {
        if (memcmp(s, "else", 4) == 0) return TOK_ELSE;
        if (memcmp(s, "true", 4) == 0) return TOK_TRUE;
        if (memcmp(s, "null", 4) == 0) return TOK_NULL;
    } else if (len == 5) {
        if (memcmp(s, "const", 5) == 0) return TOK_CONST;
        if (memcmp(s, "while", 5) == 0) return TOK_WHILE;
        if (memcmp(s, "break", 5) == 0) return TOK_BREAK;
        if (memcmp(s, "false", 5) == 0) return TOK_FALSE;
    } else if (len == 6) {
        if (memcmp(s, "return", 6) == 0) return TOK_RETURN;
        if (memcmp(s, "typeof", 6) == 0) return TOK_TYPEOF;
    } else if (len == 8) {
        if (memcmp(s, "function", 8) == 0) return TOK_FUNCTION;
        if (memcmp(s, "continue", 8) == 0) return TOK_CONTINUE;
    } else if (len == 9) {
        if (memcmp(s, "undefined", 9) == 0) return TOK_UNDEFINED;
    }
    return TOK_IDENT;
}

static void next_token(Parser *p) {
    p->prev = p->cur;
    bool nl = false;

    for (;;) {
        char c = p->src[p->pos];
        if (c == '\0') break;
        if (c == ' ' || c == '\t' || c == '\r') {
            p->pos++;
        } else if (c == '\n') {
            p->pos++;
            p->line++;
            nl = true;
        } else if (c == '/' && p->src[p->pos + 1] == '/') {
            p->pos += 2;
            while (p->src[p->pos] && p->src[p->pos] != '\n') p->pos++;
        } else if (c == '/' && p->src[p->pos + 1] == '*') {
            p->pos += 2;
            while (p->src[p->pos]) {
                if (p->src[p->pos] == '\n') { p->line++; nl = true; }
                if (p->src[p->pos] == '*' && p->src[p->pos + 1] == '/') {
                    p->pos += 2;
                    break;
                }
                p->pos++;
            }
        } else {
            break;
        }
    }

    Token t;
    memset(&t, 0, sizeof(t));
    t.line = p->line;
    t.had_newline = nl;
    t.start = p->src + p->pos;

    char c = p->src[p->pos];
    if (c == '\0') {
        t.kind = TOK_EOF;
        p->cur = t;
        return;
    }

    /* Number */
    if (isdigit((unsigned char)c) || (c == '.' && isdigit((unsigned char)p->src[p->pos + 1]))) {
        const char *start = p->src + p->pos;
        char *end = NULL;
        if (c == '0' && (p->src[p->pos + 1] == 'x' || p->src[p->pos + 1] == 'X')) {
            unsigned long long uv = strtoull(start, &end, 16);
            t.num = (double)uv;
        } else {
            t.num = strtod(start, &end);
        }
        p->pos = (size_t)(end - p->src);
        t.len = (size_t)(end - start);
        t.kind = TOK_NUM;
        p->cur = t;
        return;
    }

    /* String */
    if (c == '"' || c == '\'') {
        char quote = c;
        p->pos++;
        size_t cap = 32, len = 0;
        char *buf = (char *)malloc(cap);
        while (p->src[p->pos] && p->src[p->pos] != quote) {
            char ch = p->src[p->pos++];
            if (ch == '\\' && p->src[p->pos]) {
                char esc = p->src[p->pos++];
                switch (esc) {
                    case 'n': ch = '\n'; break;
                    case 'r': ch = '\r'; break;
                    case 't': ch = '\t'; break;
                    case '0': ch = '\0'; break;
                    case '\\': ch = '\\'; break;
                    case '"': ch = '"'; break;
                    case '\'': ch = '\''; break;
                    default: ch = esc; break;
                }
            } else if (ch == '\n') {
                p->line++;
            }
            if (len + 2 >= cap) { cap *= 2; buf = (char *)realloc(buf, cap); }
            buf[len++] = ch;
        }
        if (p->src[p->pos] == quote) {
            p->pos++;
        } else {
            vm_error(p->vm, "line %d: unterminated string literal", t.line);
            p->has_error = true;
        }
        t.kind = TOK_STR;
        t.str = arena_strndup(&p->vm->ast_arena, buf, len);
        t.str_len = len;
        free(buf);
        p->cur = t;
        return;
    }

    /* Identifier / Keyword */
    if (is_ident_start(c)) {
        size_t start = p->pos;
        while (is_ident_part(p->src[p->pos])) p->pos++;
        t.len = p->pos - start;
        t.kind = check_keyword(p->src + start, t.len);
        if (t.kind == TOK_IDENT) {
            t.str = arena_strndup(&p->vm->ast_arena, p->src + start, t.len);
            t.str_len = t.len;
        }
        p->cur = t;
        return;
    }

    /* Operators & Punctuators */
    char n1 = p->src[p->pos + 1];
    char n2 = n1 ? p->src[p->pos + 2] : '\0';
    p->pos++;
    t.len = 1;

    switch (c) {
        case '(': t.kind = TOK_LPAREN; break;
        case ')': t.kind = TOK_RPAREN; break;
        case '{': t.kind = TOK_LBRACE; break;
        case '}': t.kind = TOK_RBRACE; break;
        case '[': t.kind = TOK_LBRACKET; break;
        case ']': t.kind = TOK_RBRACKET; break;
        case ';': t.kind = TOK_SEMI; break;
        case ',': t.kind = TOK_COMMA; break;
        case '.': t.kind = TOK_DOT; break;
        case ':': t.kind = TOK_COLON; break;
        case '?': t.kind = TOK_QUESTION; break;
        case '~': t.kind = TOK_BIT_NOT; break;
        case '^': t.kind = TOK_BIT_XOR; break;
        case '+':
            if (n1 == '+') { p->pos++; t.len = 2; t.kind = TOK_INC; }
            else if (n1 == '=') { p->pos++; t.len = 2; t.kind = TOK_PLUS_EQ; }
            else t.kind = TOK_PLUS;
            break;
        case '-':
            if (n1 == '-') { p->pos++; t.len = 2; t.kind = TOK_DEC; }
            else if (n1 == '=') { p->pos++; t.len = 2; t.kind = TOK_MINUS_EQ; }
            else t.kind = TOK_MINUS;
            break;
        case '*':
            if (n1 == '=') { p->pos++; t.len = 2; t.kind = TOK_STAR_EQ; }
            else t.kind = TOK_STAR;
            break;
        case '/':
            if (n1 == '=') { p->pos++; t.len = 2; t.kind = TOK_SLASH_EQ; }
            else t.kind = TOK_SLASH;
            break;
        case '%':
            if (n1 == '=') { p->pos++; t.len = 2; t.kind = TOK_PERCENT_EQ; }
            else t.kind = TOK_PERCENT;
            break;
        case '=':
            if (n1 == '=' && n2 == '=') { p->pos += 2; t.len = 3; t.kind = TOK_SEQ; }
            else if (n1 == '=') { p->pos++; t.len = 2; t.kind = TOK_EQ; }
            else t.kind = TOK_ASSIGN;
            break;
        case '!':
            if (n1 == '=' && n2 == '=') { p->pos += 2; t.len = 3; t.kind = TOK_SNEQ; }
            else if (n1 == '=') { p->pos++; t.len = 2; t.kind = TOK_NEQ; }
            else t.kind = TOK_NOT;
            break;
        case '<':
            if (n1 == '<') { p->pos++; t.len = 2; t.kind = TOK_SHL; }
            else if (n1 == '=') { p->pos++; t.len = 2; t.kind = TOK_LE; }
            else t.kind = TOK_LT;
            break;
        case '>':
            if (n1 == '>') { p->pos++; t.len = 2; t.kind = TOK_SHR; }
            else if (n1 == '=') { p->pos++; t.len = 2; t.kind = TOK_GE; }
            else t.kind = TOK_GT;
            break;
        case '&':
            if (n1 == '&') { p->pos++; t.len = 2; t.kind = TOK_AND; }
            else t.kind = TOK_BIT_AND;
            break;
        case '|':
            if (n1 == '|') { p->pos++; t.len = 2; t.kind = TOK_OR; }
            else t.kind = TOK_BIT_OR;
            break;
        default:
            vm_error(p->vm, "line %d: unexpected character '%c'", t.line, c);
            p->has_error = true;
            t.kind = TOK_EOF;
            break;
    }
    p->cur = t;
}

/* =========================================================================
 * AST Nodes
 * ========================================================================= */

typedef enum {
    EXPR_NUM, EXPR_STR, EXPR_BOOL, EXPR_NULL, EXPR_UNDEF,
    EXPR_IDENT,
    EXPR_UNARY,
    EXPR_UPDATE, /* ++ / -- */
    EXPR_BINARY,
    EXPR_ASSIGN,
    EXPR_TERNARY,
    EXPR_CALL,
    EXPR_NEW,
    EXPR_MEMBER,
    EXPR_INDEX,
    EXPR_ARRAY,
    EXPR_OBJECT,
    EXPR_FN
} ExprKind;

typedef struct Expr Expr;

typedef struct {
    const char *key;
    Expr *val;
} ObjLitEntry;

struct Expr {
    ExprKind kind;
    int line;
    union {
        double num;
        struct { const char *data; size_t len; } str;
        bool b;
        const char *ident;
        struct { TokKind op; Expr *arg; } unary;
        struct { TokKind op; bool prefix; Expr *arg; } update;
        struct { TokKind op; Expr *left; Expr *right; } binary;
        struct { TokKind op; Expr *left; Expr *right; } assign;
        struct { Expr *cond; Expr *then_e; Expr *else_e; } ternary;
        struct { Expr *callee; int argc; Expr **argv; } call;
        struct { Expr *obj; const char *prop; } member;
        struct { Expr *obj; Expr *idx; } index;
        struct { int count; Expr **items; } arr;
        struct { int count; ObjLitEntry *entries; } obj;
        struct { const char *name; int param_count; const char **params; Stmt *body; } fn;
    } as;
};

typedef enum {
    STMT_BLOCK,
    STMT_VAR,
    STMT_EXPR,
    STMT_IF,
    STMT_WHILE,
    STMT_FOR,
    STMT_RETURN,
    STMT_BREAK,
    STMT_CONTINUE,
    STMT_FN,
    STMT_EMPTY
} StmtKind;

typedef struct {
    const char *name;
    Expr *init;
} VarDecl;

struct Stmt {
    StmtKind kind;
    int line;
    union {
        struct { int count; Stmt **stmts; } block;
        struct { bool is_const; int count; VarDecl *decls; } var;
        Expr *expr;
        struct { Expr *cond; Stmt *then_s; Stmt *else_s; } if_s;
        struct { Expr *cond; Stmt *body; } while_s;
        struct { Stmt *init; Expr *cond; Expr *update; Stmt *body; } for_s;
        Expr *ret;
        struct { const char *name; int param_count; const char **params; Stmt *body; } fn;
    } as;
};

/* =========================================================================
 * Recursive Descent Parser
 * ========================================================================= */

static Expr *new_expr(Parser *p, ExprKind k) {
    Expr *e = (Expr *)arena_alloc(&p->vm->ast_arena, sizeof(Expr));
    e->kind = k;
    e->line = p->cur.line;
    return e;
}

static Stmt *new_stmt(Parser *p, StmtKind k) {
    Stmt *s = (Stmt *)arena_alloc(&p->vm->ast_arena, sizeof(Stmt));
    s->kind = k;
    s->line = p->cur.line;
    return s;
}

static bool match(Parser *p, TokKind k) {
    if (p->cur.kind == k) {
        next_token(p);
        return true;
    }
    return false;
}

static bool expect(Parser *p, TokKind k, const char *msg) {
    if (p->cur.kind == k) {
        next_token(p);
        return true;
    }
    vm_error(p->vm, "line %d: expected %s", p->cur.line, msg);
    p->has_error = true;
    return false;
}

static void consume_semi(Parser *p) {
    if (p->cur.kind == TOK_SEMI) {
        next_token(p);
    }
}

static Expr *parse_expr(Parser *p);
static Expr *parse_assign(Parser *p);
static Stmt *parse_stmt(Parser *p);
static Stmt *parse_block(Parser *p);

static Expr *parse_primary(Parser *p) {
    if (p->has_error) return NULL;
    Token t = p->cur;
    switch (t.kind) {
        case TOK_NUM: {
            next_token(p);
            Expr *e = new_expr(p, EXPR_NUM);
            e->as.num = t.num;
            return e;
        }
        case TOK_STR: {
            next_token(p);
            Expr *e = new_expr(p, EXPR_STR);
            e->as.str.data = t.str;
            e->as.str.len = t.str_len;
            return e;
        }
        case TOK_TRUE:
        case TOK_FALSE: {
            next_token(p);
            Expr *e = new_expr(p, EXPR_BOOL);
            e->as.b = (t.kind == TOK_TRUE);
            return e;
        }
        case TOK_NULL:
            next_token(p);
            return new_expr(p, EXPR_NULL);
        case TOK_UNDEFINED:
            next_token(p);
            return new_expr(p, EXPR_UNDEF);
        case TOK_IDENT: {
            next_token(p);
            Expr *e = new_expr(p, EXPR_IDENT);
            e->as.ident = t.str;
            return e;
        }
        case TOK_LPAREN: {
            next_token(p);
            Expr *e = parse_expr(p);
            expect(p, TOK_RPAREN, "')'");
            return e;
        }
        case TOK_LBRACKET: {
            next_token(p);
            int cap = 8, count = 0;
            Expr **items = (Expr **)malloc(sizeof(Expr *) * (size_t)cap);
            while (p->cur.kind != TOK_RBRACKET && p->cur.kind != TOK_EOF && !p->has_error) {
                if (count >= cap) { cap *= 2; items = (Expr **)realloc(items, sizeof(Expr *) * (size_t)cap); }
                items[count++] = parse_assign(p);
                if (!match(p, TOK_COMMA)) break;
            }
            expect(p, TOK_RBRACKET, "']'");
            Expr *e = new_expr(p, EXPR_ARRAY);
            e->as.arr.count = count;
            if (count > 0) {
                e->as.arr.items = (Expr **)arena_alloc(&p->vm->ast_arena, sizeof(Expr *) * (size_t)count);
                memcpy(e->as.arr.items, items, sizeof(Expr *) * (size_t)count);
            }
            free(items);
            return e;
        }
        case TOK_LBRACE: {
            next_token(p);
            int cap = 8, count = 0;
            ObjLitEntry *entries = (ObjLitEntry *)malloc(sizeof(ObjLitEntry) * (size_t)cap);
            while (p->cur.kind != TOK_RBRACE && p->cur.kind != TOK_EOF && !p->has_error) {
                const char *key = NULL;
                if (p->cur.kind == TOK_IDENT || p->cur.kind == TOK_STR) {
                    key = p->cur.str;
                    next_token(p);
                } else if (p->cur.kind == TOK_NUM) {
                    char buf[64];
                    format_num(p->cur.num, buf, sizeof(buf));
                    key = arena_strndup(&p->vm->ast_arena, buf, strlen(buf));
                    next_token(p);
                } else {
                    vm_error(p->vm, "line %d: expected property key", p->cur.line);
                    p->has_error = true;
                    break;
                }
                expect(p, TOK_COLON, "':'");
                Expr *val = parse_assign(p);
                if (count >= cap) { cap *= 2; entries = (ObjLitEntry *)realloc(entries, sizeof(ObjLitEntry) * (size_t)cap); }
                entries[count].key = key;
                entries[count].val = val;
                count++;
                if (!match(p, TOK_COMMA)) break;
            }
            expect(p, TOK_RBRACE, "'}'");
            Expr *e = new_expr(p, EXPR_OBJECT);
            e->as.obj.count = count;
            if (count > 0) {
                e->as.obj.entries = (ObjLitEntry *)arena_alloc(&p->vm->ast_arena, sizeof(ObjLitEntry) * (size_t)count);
                memcpy(e->as.obj.entries, entries, sizeof(ObjLitEntry) * (size_t)count);
            }
            free(entries);
            return e;
        }
        case TOK_FUNCTION: {
            next_token(p);
            const char *name = NULL;
            if (p->cur.kind == TOK_IDENT) {
                name = p->cur.str;
                next_token(p);
            }
            expect(p, TOK_LPAREN, "'('");
            int cap = 8, count = 0;
            const char **params = (const char **)malloc(sizeof(const char *) * (size_t)cap);
            while (p->cur.kind != TOK_RPAREN && p->cur.kind != TOK_EOF && !p->has_error) {
                if (p->cur.kind != TOK_IDENT) {
                    vm_error(p->vm, "line %d: expected parameter name", p->cur.line);
                    p->has_error = true;
                    break;
                }
                if (count >= cap) { cap *= 2; params = (const char **)realloc(params, sizeof(const char *) * (size_t)cap); }
                params[count++] = p->cur.str;
                next_token(p);
                if (!match(p, TOK_COMMA)) break;
            }
            expect(p, TOK_RPAREN, "')'");
            Stmt *body = parse_block(p);
            Expr *e = new_expr(p, EXPR_FN);
            e->as.fn.name = name;
            e->as.fn.param_count = count;
            if (count > 0) {
                e->as.fn.params = (const char **)arena_alloc(&p->vm->ast_arena, sizeof(const char *) * (size_t)count);
                memcpy(e->as.fn.params, params, sizeof(const char *) * (size_t)count);
            }
            e->as.fn.body = body;
            free(params);
            return e;
        }
        default:
            vm_error(p->vm, "line %d: unexpected token in expression", p->cur.line);
            p->has_error = true;
            return NULL;
    }
}

static Expr *parse_call_member(Parser *p) {
    bool is_new = match(p, TOK_NEW);
    Expr *e = parse_primary(p);
    while (!p->has_error) {
        if (match(p, TOK_DOT)) {
            if (p->cur.kind != TOK_IDENT) {
                vm_error(p->vm, "line %d: expected property name after '.'", p->cur.line);
                p->has_error = true;
                return NULL;
            }
            Expr *m = new_expr(p, EXPR_MEMBER);
            m->as.member.obj = e;
            m->as.member.prop = p->cur.str;
            next_token(p);
            e = m;
        } else if (match(p, TOK_LBRACKET)) {
            Expr *idx = parse_expr(p);
            expect(p, TOK_RBRACKET, "']'");
            Expr *ix = new_expr(p, EXPR_INDEX);
            ix->as.index.obj = e;
            ix->as.index.idx = idx;
            e = ix;
        } else if (match(p, TOK_LPAREN)) {
            int cap = 8, argc = 0;
            Expr **argv = (Expr **)malloc(sizeof(Expr *) * (size_t)cap);
            while (p->cur.kind != TOK_RPAREN && p->cur.kind != TOK_EOF && !p->has_error) {
                if (argc >= cap) { cap *= 2; argv = (Expr **)realloc(argv, sizeof(Expr *) * (size_t)cap); }
                argv[argc++] = parse_assign(p);
                if (!match(p, TOK_COMMA)) break;
            }
            expect(p, TOK_RPAREN, "')'");
            Expr *c = new_expr(p, is_new ? EXPR_NEW : EXPR_CALL);
            is_new = false;
            c->as.call.callee = e;
            c->as.call.argc = argc;
            if (argc > 0) {
                c->as.call.argv = (Expr **)arena_alloc(&p->vm->ast_arena, sizeof(Expr *) * (size_t)argc);
                memcpy(c->as.call.argv, argv, sizeof(Expr *) * (size_t)argc);
            }
            free(argv);
            e = c;
        } else {
            break;
        }
    }
    if (is_new && !p->has_error) {
        Expr *c = new_expr(p, EXPR_NEW);
        c->as.call.callee = e;
        c->as.call.argc = 0;
        c->as.call.argv = NULL;
        e = c;
    }
    return e;
}

static Expr *parse_postfix(Parser *p) {
    Expr *e = parse_call_member(p);
    if (!p->has_error && !p->cur.had_newline &&
        (p->cur.kind == TOK_INC || p->cur.kind == TOK_DEC)) {
        TokKind op = p->cur.kind;
        next_token(p);
        Expr *u = new_expr(p, EXPR_UPDATE);
        u->as.update.op = op;
        u->as.update.prefix = false;
        u->as.update.arg = e;
        return u;
    }
    return e;
}

static Expr *parse_unary(Parser *p) {
    TokKind k = p->cur.kind;
    if (k == TOK_MINUS || k == TOK_PLUS || k == TOK_NOT || k == TOK_BIT_NOT || k == TOK_TYPEOF) {
        next_token(p);
        Expr *u = new_expr(p, EXPR_UNARY);
        u->as.unary.op = k;
        u->as.unary.arg = parse_unary(p);
        return u;
    }
    if (k == TOK_INC || k == TOK_DEC) {
        next_token(p);
        Expr *u = new_expr(p, EXPR_UPDATE);
        u->as.update.op = k;
        u->as.update.prefix = true;
        u->as.update.arg = parse_unary(p);
        return u;
    }
    return parse_postfix(p);
}

static int binary_prec(TokKind k) {
    switch (k) {
        case TOK_OR: return 1;
        case TOK_AND: return 2;
        case TOK_BIT_OR: return 3;
        case TOK_BIT_XOR: return 4;
        case TOK_BIT_AND: return 5;
        case TOK_EQ: case TOK_NEQ: case TOK_SEQ: case TOK_SNEQ: return 6;
        case TOK_LT: case TOK_LE: case TOK_GT: case TOK_GE: return 7;
        case TOK_SHL: case TOK_SHR: return 8;
        case TOK_PLUS: case TOK_MINUS: return 9;
        case TOK_STAR: case TOK_SLASH: case TOK_PERCENT: return 10;
        default: return 0;
    }
}

static Expr *parse_binary(Parser *p, int min_prec) {
    Expr *left = parse_unary(p);
    while (!p->has_error) {
        int prec = binary_prec(p->cur.kind);
        if (prec < min_prec) break;
        TokKind op = p->cur.kind;
        next_token(p);
        Expr *right = parse_binary(p, prec + 1);
        Expr *b = new_expr(p, EXPR_BINARY);
        b->as.binary.op = op;
        b->as.binary.left = left;
        b->as.binary.right = right;
        left = b;
    }
    return left;
}

static Expr *parse_ternary(Parser *p) {
    Expr *cond = parse_binary(p, 1);
    if (!p->has_error && match(p, TOK_QUESTION)) {
        Expr *t = parse_assign(p);
        expect(p, TOK_COLON, "':'");
        Expr *f = parse_assign(p);
        Expr *e = new_expr(p, EXPR_TERNARY);
        e->as.ternary.cond = cond;
        e->as.ternary.then_e = t;
        e->as.ternary.else_e = f;
        return e;
    }
    return cond;
}

static bool is_assign_op(TokKind k) {
    return k == TOK_ASSIGN || k == TOK_PLUS_EQ || k == TOK_MINUS_EQ ||
           k == TOK_STAR_EQ || k == TOK_SLASH_EQ || k == TOK_PERCENT_EQ;
}

static Expr *parse_assign(Parser *p) {
    Expr *left = parse_ternary(p);
    if (!p->has_error && is_assign_op(p->cur.kind)) {
        TokKind op = p->cur.kind;
        next_token(p);
        Expr *right = parse_assign(p);
        Expr *a = new_expr(p, EXPR_ASSIGN);
        a->as.assign.op = op;
        a->as.assign.left = left;
        a->as.assign.right = right;
        return a;
    }
    return left;
}

static Expr *parse_expr(Parser *p) {
    return parse_assign(p);
}

static Stmt *parse_var_stmt(Parser *p, bool consume_end_semi) {
    bool is_const = (p->cur.kind == TOK_CONST);
    next_token(p);
    int cap = 4, count = 0;
    VarDecl *decls = (VarDecl *)malloc(sizeof(VarDecl) * (size_t)cap);
    for (;;) {
        if (p->cur.kind != TOK_IDENT) {
            vm_error(p->vm, "line %d: expected variable name", p->cur.line);
            p->has_error = true;
            break;
        }
        const char *name = p->cur.str;
        next_token(p);
        Expr *init = NULL;
        if (match(p, TOK_ASSIGN)) {
            init = parse_assign(p);
        }
        if (count >= cap) { cap *= 2; decls = (VarDecl *)realloc(decls, sizeof(VarDecl) * (size_t)cap); }
        decls[count].name = name;
        decls[count].init = init;
        count++;
        if (!match(p, TOK_COMMA)) break;
    }
    if (consume_end_semi) consume_semi(p);
    Stmt *s = new_stmt(p, STMT_VAR);
    s->as.var.is_const = is_const;
    s->as.var.count = count;
    if (count > 0) {
        s->as.var.decls = (VarDecl *)arena_alloc(&p->vm->ast_arena, sizeof(VarDecl) * (size_t)count);
        memcpy(s->as.var.decls, decls, sizeof(VarDecl) * (size_t)count);
    }
    free(decls);
    return s;
}

static Stmt *parse_block(Parser *p) {
    expect(p, TOK_LBRACE, "'{'");
    int cap = 16, count = 0;
    Stmt **stmts = (Stmt **)malloc(sizeof(Stmt *) * (size_t)cap);
    while (p->cur.kind != TOK_RBRACE && p->cur.kind != TOK_EOF && !p->has_error) {
        if (count >= cap) { cap *= 2; stmts = (Stmt **)realloc(stmts, sizeof(Stmt *) * (size_t)cap); }
        stmts[count++] = parse_stmt(p);
    }
    expect(p, TOK_RBRACE, "'}'");
    Stmt *b = new_stmt(p, STMT_BLOCK);
    b->as.block.count = count;
    if (count > 0) {
        b->as.block.stmts = (Stmt **)arena_alloc(&p->vm->ast_arena, sizeof(Stmt *) * (size_t)count);
        memcpy(b->as.block.stmts, stmts, sizeof(Stmt *) * (size_t)count);
    }
    free(stmts);
    return b;
}

static Stmt *parse_stmt(Parser *p) {
    if (p->has_error) return NULL;
    switch (p->cur.kind) {
        case TOK_SEMI:
            next_token(p);
            return new_stmt(p, STMT_EMPTY);
        case TOK_LBRACE:
            return parse_block(p);
        case TOK_LET:
        case TOK_CONST:
        case TOK_VAR:
            return parse_var_stmt(p, true);
        case TOK_FUNCTION: {
            next_token(p);
            if (p->cur.kind != TOK_IDENT) {
                vm_error(p->vm, "line %d: expected function name", p->cur.line);
                p->has_error = true;
                return NULL;
            }
            const char *name = p->cur.str;
            next_token(p);
            expect(p, TOK_LPAREN, "'('");
            int cap = 8, count = 0;
            const char **params = (const char **)malloc(sizeof(const char *) * (size_t)cap);
            while (p->cur.kind != TOK_RPAREN && p->cur.kind != TOK_EOF && !p->has_error) {
                if (p->cur.kind != TOK_IDENT) {
                    vm_error(p->vm, "line %d: expected parameter name", p->cur.line);
                    p->has_error = true;
                    break;
                }
                if (count >= cap) { cap *= 2; params = (const char **)realloc(params, sizeof(const char *) * (size_t)cap); }
                params[count++] = p->cur.str;
                next_token(p);
                if (!match(p, TOK_COMMA)) break;
            }
            expect(p, TOK_RPAREN, "')'");
            Stmt *body = parse_block(p);
            Stmt *s = new_stmt(p, STMT_FN);
            s->as.fn.name = name;
            s->as.fn.param_count = count;
            if (count > 0) {
                s->as.fn.params = (const char **)arena_alloc(&p->vm->ast_arena, sizeof(const char *) * (size_t)count);
                memcpy(s->as.fn.params, params, sizeof(const char *) * (size_t)count);
            }
            s->as.fn.body = body;
            free(params);
            return s;
        }
        case TOK_IF: {
            next_token(p);
            expect(p, TOK_LPAREN, "'('");
            Expr *cond = parse_expr(p);
            expect(p, TOK_RPAREN, "')'");
            Stmt *then_s = parse_stmt(p);
            Stmt *else_s = NULL;
            if (match(p, TOK_ELSE)) {
                else_s = parse_stmt(p);
            }
            Stmt *s = new_stmt(p, STMT_IF);
            s->as.if_s.cond = cond;
            s->as.if_s.then_s = then_s;
            s->as.if_s.else_s = else_s;
            return s;
        }
        case TOK_WHILE: {
            next_token(p);
            expect(p, TOK_LPAREN, "'('");
            Expr *cond = parse_expr(p);
            expect(p, TOK_RPAREN, "')'");
            Stmt *body = parse_stmt(p);
            Stmt *s = new_stmt(p, STMT_WHILE);
            s->as.while_s.cond = cond;
            s->as.while_s.body = body;
            return s;
        }
        case TOK_FOR: {
            next_token(p);
            expect(p, TOK_LPAREN, "'('");
            Stmt *init = NULL;
            if (p->cur.kind != TOK_SEMI) {
                if (p->cur.kind == TOK_LET || p->cur.kind == TOK_CONST || p->cur.kind == TOK_VAR) {
                    init = parse_var_stmt(p, false);
                } else {
                    init = new_stmt(p, STMT_EXPR);
                    init->as.expr = parse_expr(p);
                }
            }
            expect(p, TOK_SEMI, "';'");
            Expr *cond = NULL;
            if (p->cur.kind != TOK_SEMI) cond = parse_expr(p);
            expect(p, TOK_SEMI, "';'");
            Expr *update = NULL;
            if (p->cur.kind != TOK_RPAREN) update = parse_expr(p);
            expect(p, TOK_RPAREN, "')'");
            Stmt *body = parse_stmt(p);
            Stmt *s = new_stmt(p, STMT_FOR);
            s->as.for_s.init = init;
            s->as.for_s.cond = cond;
            s->as.for_s.update = update;
            s->as.for_s.body = body;
            return s;
        }
        case TOK_RETURN: {
            next_token(p);
            Expr *ret = NULL;
            if (p->cur.kind != TOK_SEMI && p->cur.kind != TOK_RBRACE &&
                p->cur.kind != TOK_EOF && !p->cur.had_newline) {
                ret = parse_expr(p);
            }
            consume_semi(p);
            Stmt *s = new_stmt(p, STMT_RETURN);
            s->as.ret = ret;
            return s;
        }
        case TOK_BREAK:
            next_token(p);
            consume_semi(p);
            return new_stmt(p, STMT_BREAK);
        case TOK_CONTINUE:
            next_token(p);
            consume_semi(p);
            return new_stmt(p, STMT_CONTINUE);
        default: {
            Expr *e = parse_expr(p);
            consume_semi(p);
            Stmt *s = new_stmt(p, STMT_EXPR);
            s->as.expr = e;
            return s;
        }
    }
}

/* =========================================================================
 * Evaluator
 * ========================================================================= */

static EsVal eval_expr(B8gEsVm *vm, EsEnv *env, Expr *e);
static EsVal eval_stmt(B8gEsVm *vm, EsEnv *env, Stmt *s);

static EsVal eval_arr_push(B8gEsVm *vm, EsVal this_val, int argc, EsVal *argv) {
    if (this_val.kind != VAL_ARR) {
        vm_error(vm, "push called on non-array");
        return val_undef();
    }
    for (int i = 0; i < argc; i++) {
        arr_push(vm, this_val.as.a, argv[i]);
    }
    return val_num((double)this_val.as.a->len);
}

static EsVal eval_get_member(B8gEsVm *vm, EsVal obj, const char *prop) {
    if (obj.kind == VAL_STR) {
        if (strcmp(prop, "length") == 0) return val_num((double)obj.as.s->len);
        return val_undef();
    }
    if (obj.kind == VAL_ARR) {
        if (strcmp(prop, "length") == 0) return val_num((double)obj.as.a->len);
        if (strcmp(prop, "push") == 0) return val_native(eval_arr_push);
        return val_undef();
    }
    if (obj.kind == VAL_U8ARR) {
        if (strcmp(prop, "length") == 0) return val_num((double)obj.as.u->len);
        return val_undef();
    }
    if (obj.kind == VAL_OBJ) {
        EsVal out;
        if (obj_get(obj.as.o, prop, &out)) return out;
        return val_undef();
    }
    vm_error(vm, "cannot read property '%s' of non-object", prop);
    return val_undef();
}

static EsVal eval_get_index(B8gEsVm *vm, EsVal obj, EsVal idx) {
    if (obj.kind == VAL_ARR) {
        if (idx.kind == VAL_STR && strcmp(idx.as.s->data, "length") == 0) {
            return val_num((double)obj.as.a->len);
        }
        int64_t i = (int64_t)val_to_num(idx);
        if (i < 0 || (size_t)i >= obj.as.a->len) return val_undef();
        return obj.as.a->items[i];
    }
    if (obj.kind == VAL_U8ARR) {
        int64_t i = (int64_t)val_to_num(idx);
        if (i < 0 || (size_t)i >= obj.as.u->len) return val_undef();
        return val_num((double)obj.as.u->data[i]);
    }
    if (obj.kind == VAL_STR) {
        int64_t i = (int64_t)val_to_num(idx);
        if (i < 0 || (size_t)i >= obj.as.s->len) return val_undef();
        return val_str(new_str_len(vm, obj.as.s->data + i, 1));
    }
    if (obj.kind == VAL_OBJ) {
        EsStr *ks = val_to_str(vm, idx);
        if (!ks) return val_undef();
        EsVal out;
        if (obj_get(obj.as.o, ks->data, &out)) return out;
        return val_undef();
    }
    vm_error(vm, "cannot index non-object");
    return val_undef();
}

static void eval_set_member(B8gEsVm *vm, EsVal obj, const char *prop, EsVal val) {
    if (obj.kind == VAL_OBJ) {
        obj_set(vm, obj.as.o, prop, val);
        return;
    }
    vm_error(vm, "cannot set property '%s' on non-object", prop);
}

static void eval_set_index(B8gEsVm *vm, EsVal obj, EsVal idx, EsVal val) {
    if (obj.kind == VAL_ARR) {
        int64_t i = (int64_t)val_to_num(idx);
        if (i < 0) return;
        while (obj.as.a->len <= (size_t)i) {
            arr_push(vm, obj.as.a, val_undef());
            if (vm->signal == SIG_ERROR) return;
        }
        obj.as.a->items[i] = val;
        return;
    }
    if (obj.kind == VAL_U8ARR) {
        int64_t i = (int64_t)val_to_num(idx);
        if (i < 0 || (size_t)i >= obj.as.u->len) return;
        obj.as.u->data[i] = (uint8_t)(val_to_i32(val) & 0xFF);
        return;
    }
    if (obj.kind == VAL_OBJ) {
        EsStr *ks = val_to_str(vm, idx);
        if (!ks) return;
        obj_set(vm, obj.as.o, ks->data, val);
        return;
    }
    vm_error(vm, "cannot assign index on non-object");
}

static EsVal apply_compound(B8gEsVm *vm, TokKind op, EsVal cur, EsVal rhs) {
    switch (op) {
        case TOK_ASSIGN: return rhs;
        case TOK_PLUS_EQ:
            if (cur.kind == VAL_STR || rhs.kind == VAL_STR) {
                EsStr *a = val_to_str(vm, cur);
                EsStr *b = val_to_str(vm, rhs);
                if (!a || !b) return val_undef();
                size_t len = a->len + b->len;
                char *buf = (char *)malloc(len + 1);
                memcpy(buf, a->data, a->len);
                memcpy(buf + a->len, b->data, b->len);
                buf[len] = '\0';
                EsStr *res = new_str_len(vm, buf, len);
                free(buf);
                return val_str(res);
            }
            return val_num(val_to_num(cur) + val_to_num(rhs));
        case TOK_MINUS_EQ:   return val_num(val_to_num(cur) - val_to_num(rhs));
        case TOK_STAR_EQ:    return val_num(val_to_num(cur) * val_to_num(rhs));
        case TOK_SLASH_EQ:   return val_num(val_to_num(cur) / val_to_num(rhs));
        case TOK_PERCENT_EQ: return val_num(fmod(val_to_num(cur), val_to_num(rhs)));
        default: return rhs;
    }
}

static EsVal eval_call_fn(B8gEsVm *vm, EsVal callee, EsVal this_val, int argc, EsVal *argv) {
    if (callee.kind == VAL_NATIVE) {
        return callee.as.native(vm, this_val, argc, argv);
    }
    if (callee.kind != VAL_FN) {
        vm_error(vm, "value is not callable");
        return val_undef();
    }
    if (vm->call_depth >= 1024) {
        vm_error(vm, "maximum call stack size exceeded");
        return val_undef();
    }
    EsFn *fn = callee.as.f;
    EsEnv *fenv = env_new(vm, fn->closure);
    if (!fenv) return val_undef();
    for (int i = 0; i < fn->param_count; i++) {
        EsVal av = (i < argc) ? argv[i] : val_undef();
        env_define(vm, fenv, fn->params[i], av, false);
    }

    vm->call_depth++;
    /* Evaluate function body statements directly in fenv */
    Stmt *body = fn->body;
    for (int i = 0; i < body->as.block.count; i++) {
        Stmt *st = body->as.block.stmts[i];
        if (st->kind == STMT_FN) {
            EsFn *sub = new_fn(vm, st->as.fn.name, st->as.fn.param_count,
                               st->as.fn.params, st->as.fn.body, fenv);
            env_define(vm, fenv, st->as.fn.name, val_fn(sub), false);
        }
    }
    for (int i = 0; i < body->as.block.count; i++) {
        Stmt *st = body->as.block.stmts[i];
        if (st->kind == STMT_FN) continue;
        eval_stmt(vm, fenv, st);
        if (vm->signal != SIG_NONE) break;
    }
    vm->call_depth--;

    EsVal ret = val_undef();
    if (vm->signal == SIG_RETURN) {
        ret = vm->signal_val;
        vm->signal = SIG_NONE;
        vm->signal_val = val_undef();
    }
    env_release(vm, fenv);
    return ret;
}

static EsVal eval_expr(B8gEsVm *vm, EsEnv *env, Expr *e) {
    if (!e || vm->signal != SIG_NONE) return val_undef();
    switch (e->kind) {
        case EXPR_NUM:   return val_num(e->as.num);
        case EXPR_BOOL:  return val_bool(e->as.b);
        case EXPR_NULL:  return val_null();
        case EXPR_UNDEF: return val_undef();
        case EXPR_STR:   return val_str(new_str_len(vm, e->as.str.data, e->as.str.len));
        case EXPR_IDENT: {
            EsBinding *b = env_lookup(env, e->as.ident);
            if (!b) {
                vm_error(vm, "ReferenceError: '%s' is not defined", e->as.ident);
                return val_undef();
            }
            return b->val;
        }
        case EXPR_UNARY: {
            if (e->as.unary.op == TOK_TYPEOF) {
                if (e->as.unary.arg->kind == EXPR_IDENT &&
                    !env_lookup(env, e->as.unary.arg->as.ident)) {
                    return val_str(new_str(vm, "undefined"));
                }
                EsVal v = eval_expr(vm, env, e->as.unary.arg);
                if (vm->signal != SIG_NONE) return val_undef();
                switch (v.kind) {
                    case VAL_UNDEFINED: return val_str(new_str(vm, "undefined"));
                    case VAL_NULL:      return val_str(new_str(vm, "object"));
                    case VAL_BOOL:      return val_str(new_str(vm, "boolean"));
                    case VAL_NUM:       return val_str(new_str(vm, "number"));
                    case VAL_STR:       return val_str(new_str(vm, "string"));
                    case VAL_FN:
                    case VAL_NATIVE:    return val_str(new_str(vm, "function"));
                    default:            return val_str(new_str(vm, "object"));
                }
            }
            EsVal v = eval_expr(vm, env, e->as.unary.arg);
            if (vm->signal != SIG_NONE) return val_undef();
            switch (e->as.unary.op) {
                case TOK_MINUS:   return val_num(-val_to_num(v));
                case TOK_PLUS:    return val_num(val_to_num(v));
                case TOK_NOT:     return val_bool(!val_truthy(v));
                case TOK_BIT_NOT: return val_num((double)(~val_to_i32(v)));
                default: return val_undef();
            }
        }
        case EXPR_UPDATE: {
            double delta = (e->as.update.op == TOK_INC) ? 1.0 : -1.0;
            Expr *target = e->as.update.arg;
            if (target->kind == EXPR_IDENT) {
                EsBinding *b = env_lookup(env, target->as.ident);
                if (!b) { vm_error(vm, "ReferenceError: '%s' is not defined", target->as.ident); return val_undef(); }
                if (b->is_const) { vm_error(vm, "TypeError: assignment to constant '%s'", target->as.ident); return val_undef(); }
                double old_n = val_to_num(b->val);
                double new_n = old_n + delta;
                b->val = val_num(new_n);
                return val_num(e->as.update.prefix ? new_n : old_n);
            } else if (target->kind == EXPR_MEMBER) {
                EsVal obj = eval_expr(vm, env, target->as.member.obj);
                if (vm->signal != SIG_NONE) return val_undef();
                double old_n = val_to_num(eval_get_member(vm, obj, target->as.member.prop));
                double new_n = old_n + delta;
                eval_set_member(vm, obj, target->as.member.prop, val_num(new_n));
                return val_num(e->as.update.prefix ? new_n : old_n);
            } else if (target->kind == EXPR_INDEX) {
                EsVal obj = eval_expr(vm, env, target->as.index.obj);
                EsVal idx = eval_expr(vm, env, target->as.index.idx);
                if (vm->signal != SIG_NONE) return val_undef();
                double old_n = val_to_num(eval_get_index(vm, obj, idx));
                double new_n = old_n + delta;
                eval_set_index(vm, obj, idx, val_num(new_n));
                return val_num(e->as.update.prefix ? new_n : old_n);
            }
            vm_error(vm, "invalid update target");
            return val_undef();
        }
        case EXPR_BINARY: {
            TokKind op = e->as.binary.op;
            if (op == TOK_AND) {
                EsVal l = eval_expr(vm, env, e->as.binary.left);
                if (vm->signal != SIG_NONE || !val_truthy(l)) return l;
                return eval_expr(vm, env, e->as.binary.right);
            }
            if (op == TOK_OR) {
                EsVal l = eval_expr(vm, env, e->as.binary.left);
                if (vm->signal != SIG_NONE || val_truthy(l)) return l;
                return eval_expr(vm, env, e->as.binary.right);
            }
            EsVal l = eval_expr(vm, env, e->as.binary.left);
            if (vm->signal != SIG_NONE) return val_undef();
            EsVal r = eval_expr(vm, env, e->as.binary.right);
            if (vm->signal != SIG_NONE) return val_undef();

            switch (op) {
                case TOK_PLUS:
                    if (l.kind == VAL_STR || r.kind == VAL_STR) {
                        EsStr *a = val_to_str(vm, l);
                        EsStr *b = val_to_str(vm, r);
                        if (!a || !b) return val_undef();
                        size_t len = a->len + b->len;
                        char *buf = (char *)malloc(len + 1);
                        memcpy(buf, a->data, a->len);
                        memcpy(buf + a->len, b->data, b->len);
                        buf[len] = '\0';
                        EsStr *res = new_str_len(vm, buf, len);
                        free(buf);
                        return val_str(res);
                    }
                    return val_num(val_to_num(l) + val_to_num(r));
                case TOK_MINUS:   return val_num(val_to_num(l) - val_to_num(r));
                case TOK_STAR:    return val_num(val_to_num(l) * val_to_num(r));
                case TOK_SLASH:   return val_num(val_to_num(l) / val_to_num(r));
                case TOK_PERCENT: return val_num(fmod(val_to_num(l), val_to_num(r)));
                case TOK_EQ:      return val_bool(val_loose_eq(l, r));
                case TOK_NEQ:     return val_bool(!val_loose_eq(l, r));
                case TOK_SEQ:     return val_bool(val_strict_eq(l, r));
                case TOK_SNEQ:    return val_bool(!val_strict_eq(l, r));
                case TOK_LT:
                    if (l.kind == VAL_STR && r.kind == VAL_STR)
                        return val_bool(strcmp(l.as.s->data, r.as.s->data) < 0);
                    return val_bool(val_to_num(l) < val_to_num(r));
                case TOK_LE:
                    if (l.kind == VAL_STR && r.kind == VAL_STR)
                        return val_bool(strcmp(l.as.s->data, r.as.s->data) <= 0);
                    return val_bool(val_to_num(l) <= val_to_num(r));
                case TOK_GT:
                    if (l.kind == VAL_STR && r.kind == VAL_STR)
                        return val_bool(strcmp(l.as.s->data, r.as.s->data) > 0);
                    return val_bool(val_to_num(l) > val_to_num(r));
                case TOK_GE:
                    if (l.kind == VAL_STR && r.kind == VAL_STR)
                        return val_bool(strcmp(l.as.s->data, r.as.s->data) >= 0);
                    return val_bool(val_to_num(l) >= val_to_num(r));
                case TOK_BIT_AND: return val_num((double)(val_to_i32(l) & val_to_i32(r)));
                case TOK_BIT_OR:  return val_num((double)(val_to_i32(l) | val_to_i32(r)));
                case TOK_BIT_XOR: return val_num((double)(val_to_i32(l) ^ val_to_i32(r)));
                case TOK_SHL:     return val_num((double)(val_to_i32(l) << (val_to_i32(r) & 31)));
                case TOK_SHR:     return val_num((double)(val_to_i32(l) >> (val_to_i32(r) & 31)));
                default: return val_undef();
            }
        }
        case EXPR_TERNARY: {
            EsVal c = eval_expr(vm, env, e->as.ternary.cond);
            if (vm->signal != SIG_NONE) return val_undef();
            return eval_expr(vm, env, val_truthy(c) ? e->as.ternary.then_e : e->as.ternary.else_e);
        }
        case EXPR_ASSIGN: {
            Expr *lhs = e->as.assign.left;
            TokKind op = e->as.assign.op;
            if (lhs->kind == EXPR_IDENT) {
                EsVal rhs = eval_expr(vm, env, e->as.assign.right);
                if (vm->signal != SIG_NONE) return val_undef();
                EsBinding *b = env_lookup(env, lhs->as.ident);
                if (!b) {
                    if (op != TOK_ASSIGN) {
                        vm_error(vm, "ReferenceError: '%s' is not defined", lhs->as.ident);
                        return val_undef();
                    }
                    env_define(vm, vm->global_env, lhs->as.ident, rhs, false);
                    return rhs;
                }
                if (b->is_const) {
                    vm_error(vm, "TypeError: assignment to constant '%s'", lhs->as.ident);
                    return val_undef();
                }
                EsVal nv = apply_compound(vm, op, b->val, rhs);
                b->val = nv;
                return nv;
            }
            if (lhs->kind == EXPR_MEMBER) {
                EsVal obj = eval_expr(vm, env, lhs->as.member.obj);
                if (vm->signal != SIG_NONE) return val_undef();
                EsVal rhs = eval_expr(vm, env, e->as.assign.right);
                if (vm->signal != SIG_NONE) return val_undef();
                EsVal cur = (op == TOK_ASSIGN) ? val_undef() : eval_get_member(vm, obj, lhs->as.member.prop);
                EsVal nv = apply_compound(vm, op, cur, rhs);
                eval_set_member(vm, obj, lhs->as.member.prop, nv);
                return nv;
            }
            if (lhs->kind == EXPR_INDEX) {
                EsVal obj = eval_expr(vm, env, lhs->as.index.obj);
                if (vm->signal != SIG_NONE) return val_undef();
                EsVal idx = eval_expr(vm, env, lhs->as.index.idx);
                if (vm->signal != SIG_NONE) return val_undef();
                EsVal rhs = eval_expr(vm, env, e->as.assign.right);
                if (vm->signal != SIG_NONE) return val_undef();
                EsVal cur = (op == TOK_ASSIGN) ? val_undef() : eval_get_index(vm, obj, idx);
                EsVal nv = apply_compound(vm, op, cur, rhs);
                eval_set_index(vm, obj, idx, nv);
                return nv;
            }
            vm_error(vm, "invalid assignment target");
            return val_undef();
        }
        case EXPR_MEMBER: {
            EsVal obj = eval_expr(vm, env, e->as.member.obj);
            if (vm->signal != SIG_NONE) return val_undef();
            return eval_get_member(vm, obj, e->as.member.prop);
        }
        case EXPR_INDEX: {
            EsVal obj = eval_expr(vm, env, e->as.index.obj);
            if (vm->signal != SIG_NONE) return val_undef();
            EsVal idx = eval_expr(vm, env, e->as.index.idx);
            if (vm->signal != SIG_NONE) return val_undef();
            return eval_get_index(vm, obj, idx);
        }
        case EXPR_CALL:
        case EXPR_NEW: {
            EsVal this_val = val_undef();
            EsVal callee;
            if (e->as.call.callee->kind == EXPR_MEMBER) {
                this_val = eval_expr(vm, env, e->as.call.callee->as.member.obj);
                if (vm->signal != SIG_NONE) return val_undef();
                callee = eval_get_member(vm, this_val, e->as.call.callee->as.member.prop);
            } else {
                callee = eval_expr(vm, env, e->as.call.callee);
            }
            if (vm->signal != SIG_NONE) return val_undef();
            EsVal stack_args[16];
            EsVal *argv = e->as.call.argc <= 16
                              ? stack_args
                              : (EsVal *)malloc(sizeof(EsVal) * (size_t)e->as.call.argc);
            for (int i = 0; i < e->as.call.argc; i++) {
                argv[i] = eval_expr(vm, env, e->as.call.argv[i]);
                if (vm->signal != SIG_NONE) {
                    if (argv != stack_args) free(argv);
                    return val_undef();
                }
            }
            EsVal res = eval_call_fn(vm, callee, this_val, e->as.call.argc, argv);
            if (argv != stack_args) free(argv);
            return res;
        }
        case EXPR_ARRAY: {
            EsArr *a = new_arr(vm, (size_t)e->as.arr.count);
            if (!a) return val_undef();
            for (int i = 0; i < e->as.arr.count; i++) {
                EsVal v = eval_expr(vm, env, e->as.arr.items[i]);
                if (vm->signal != SIG_NONE) return val_undef();
                arr_push(vm, a, v);
            }
            return val_arr(a);
        }
        case EXPR_OBJECT: {
            EsObj *o = new_obj(vm);
            if (!o) return val_undef();
            for (int i = 0; i < e->as.obj.count; i++) {
                EsVal v = eval_expr(vm, env, e->as.obj.entries[i].val);
                if (vm->signal != SIG_NONE) return val_undef();
                obj_set(vm, o, e->as.obj.entries[i].key, v);
            }
            return val_obj(o);
        }
        case EXPR_FN: {
            EsFn *f = new_fn(vm, e->as.fn.name, e->as.fn.param_count,
                             e->as.fn.params, e->as.fn.body, env);
            return val_fn(f);
        }
    }
    return val_undef();
}

static EsVal eval_stmt(B8gEsVm *vm, EsEnv *env, Stmt *s) {
    if (!s || vm->signal != SIG_NONE) return val_undef();
    switch (s->kind) {
        case STMT_EMPTY:
            return val_undef();
        case STMT_EXPR:
            return eval_expr(vm, env, s->as.expr);
        case STMT_VAR:
            for (int i = 0; i < s->as.var.count; i++) {
                EsVal v = s->as.var.decls[i].init
                              ? eval_expr(vm, env, s->as.var.decls[i].init)
                              : val_undef();
                if (vm->signal != SIG_NONE) return val_undef();
                env_define(vm, env, s->as.var.decls[i].name, v, s->as.var.is_const);
            }
            return val_undef();
        case STMT_FN: {
            EsFn *f = new_fn(vm, s->as.fn.name, s->as.fn.param_count,
                             s->as.fn.params, s->as.fn.body, env);
            env_define(vm, env, s->as.fn.name, val_fn(f), false);
            return val_undef();
        }
        case STMT_BLOCK: {
            EsEnv *benv = env_new(vm, env);
            if (!benv) return val_undef();
            EsVal last = val_undef();
            for (int i = 0; i < s->as.block.count; i++) {
                Stmt *st = s->as.block.stmts[i];
                if (st->kind == STMT_FN) {
                    EsFn *f = new_fn(vm, st->as.fn.name, st->as.fn.param_count,
                                     st->as.fn.params, st->as.fn.body, benv);
                    env_define(vm, benv, st->as.fn.name, val_fn(f), false);
                }
            }
            for (int i = 0; i < s->as.block.count; i++) {
                Stmt *st = s->as.block.stmts[i];
                if (st->kind == STMT_FN) continue;
                last = eval_stmt(vm, benv, st);
                if (vm->signal != SIG_NONE) break;
            }
            env_release(vm, benv);
            return last;
        }
        case STMT_IF: {
            EsVal c = eval_expr(vm, env, s->as.if_s.cond);
            if (vm->signal != SIG_NONE) return val_undef();
            if (val_truthy(c)) {
                return eval_stmt(vm, env, s->as.if_s.then_s);
            } else if (s->as.if_s.else_s) {
                return eval_stmt(vm, env, s->as.if_s.else_s);
            }
            return val_undef();
        }
        case STMT_WHILE: {
            EsVal last = val_undef();
            while (vm->signal == SIG_NONE) {
                EsVal c = eval_expr(vm, env, s->as.while_s.cond);
                if (vm->signal != SIG_NONE || !val_truthy(c)) break;
                last = eval_stmt(vm, env, s->as.while_s.body);
                if (vm->signal == SIG_BREAK) {
                    vm->signal = SIG_NONE;
                    break;
                }
                if (vm->signal == SIG_CONTINUE) {
                    vm->signal = SIG_NONE;
                }
            }
            return last;
        }
        case STMT_FOR: {
            EsEnv *fenv = env_new(vm, env);
            if (!fenv) return val_undef();
            EsVal last = val_undef();
            if (s->as.for_s.init) {
                eval_stmt(vm, fenv, s->as.for_s.init);
            }
            while (vm->signal == SIG_NONE) {
                if (s->as.for_s.cond) {
                    EsVal c = eval_expr(vm, fenv, s->as.for_s.cond);
                    if (vm->signal != SIG_NONE || !val_truthy(c)) break;
                }
                last = eval_stmt(vm, fenv, s->as.for_s.body);
                if (vm->signal == SIG_BREAK) {
                    vm->signal = SIG_NONE;
                    break;
                }
                if (vm->signal == SIG_CONTINUE) {
                    vm->signal = SIG_NONE;
                }
                if (vm->signal != SIG_NONE) break;
                if (s->as.for_s.update) {
                    eval_expr(vm, fenv, s->as.for_s.update);
                }
            }
            env_release(vm, fenv);
            return last;
        }
        case STMT_RETURN: {
            EsVal v = s->as.ret ? eval_expr(vm, env, s->as.ret) : val_undef();
            if (vm->signal != SIG_NONE) return val_undef();
            vm->signal = SIG_RETURN;
            vm->signal_val = v;
            return v;
        }
        case STMT_BREAK:
            vm->signal = SIG_BREAK;
            return val_undef();
        case STMT_CONTINUE:
            vm->signal = SIG_CONTINUE;
            return val_undef();
    }
    return val_undef();
}

/* =========================================================================
 * Native Systems Builtins
 * ========================================================================= */

static EsVal native_console_log(B8gEsVm *vm, EsVal this_val, int argc, EsVal *argv) {
    (void)this_val;
    for (int i = 0; i < argc; i++) {
        if (i > 0) fputc(' ', stdout);
        EsStr *s = val_to_str(vm, argv[i]);
        if (s) fwrite(s->data, 1, s->len, stdout);
    }
    fputc('\n', stdout);
    fflush(stdout);
    vm->did_print = 1;
    return val_undef();
}

static EsVal native_uint8array(B8gEsVm *vm, EsVal this_val, int argc, EsVal *argv) {
    (void)this_val;
    double n = (argc > 0) ? val_to_num(argv[0]) : 0.0;
    if (isnan(n) || n < 0.0) n = 0.0;
    EsU8Arr *u = new_u8arr(vm, (size_t)n);
    if (!u) return val_undef();
    return val_u8(u);
}

static EsVal native_sys_platform(B8gEsVm *vm, EsVal this_val, int argc, EsVal *argv) {
    (void)this_val; (void)argc; (void)argv;
#if defined(_WIN32)
    return val_str(new_str(vm, "win32"));
#else
    return val_str(new_str(vm, "linux"));
#endif
}

static EsVal native_sys_clock_ns(B8gEsVm *vm, EsVal this_val, int argc, EsVal *argv) {
    (void)vm; (void)this_val; (void)argc; (void)argv;
#if defined(_WIN32)
    static LARGE_INTEGER freq;
    if (freq.QuadPart == 0) QueryPerformanceFrequency(&freq);
    LARGE_INTEGER cnt;
    QueryPerformanceCounter(&cnt);
    return val_num((double)cnt.QuadPart * 1e9 / (double)freq.QuadPart);
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return val_num((double)ts.tv_sec * 1e9 + (double)ts.tv_nsec);
#endif
}

static EsVal native_sys_read_file(B8gEsVm *vm, EsVal this_val, int argc, EsVal *argv) {
    (void)this_val;
    if (argc < 1) {
        vm_error(vm, "sys.readFile requires a path argument");
        return val_undef();
    }
    EsStr *path = val_to_str(vm, argv[0]);
    if (!path) return val_undef();
    FILE *f = fopen(path->data, "rb");
    if (!f) {
        vm_error(vm, "sys.readFile: cannot open '%s'", path->data);
        return val_undef();
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    if (sz < 0) sz = 0;
    fseek(f, 0, SEEK_SET);
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        vm_error(vm, "out of memory");
        return val_undef();
    }
    size_t nread = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[nread] = '\0';
    EsStr *res = new_str_len(vm, buf, nread);
    free(buf);
    return val_str(res);
}

static EsVal native_sys_write_file(B8gEsVm *vm, EsVal this_val, int argc, EsVal *argv) {
    (void)this_val;
    if (argc < 2) {
        vm_error(vm, "sys.writeFile requires (path, text)");
        return val_undef();
    }
    EsStr *path = val_to_str(vm, argv[0]);
    EsStr *text = val_to_str(vm, argv[1]);
    if (!path || !text) return val_undef();
    FILE *f = fopen(path->data, "wb");
    if (!f) {
        vm_error(vm, "sys.writeFile: cannot open '%s'", path->data);
        return val_undef();
    }
    size_t nw = fwrite(text->data, 1, text->len, f);
    fclose(f);
    if (nw != text->len) {
        vm_error(vm, "sys.writeFile: short write to '%s'", path->data);
        return val_undef();
    }
    return val_bool(true);
}

/* =========================================================================
 * Public C11 API
 * ========================================================================= */

B8gEsVm *b8g_es_create(void) {
    B8gEsVm *vm = (B8gEsVm *)calloc(1, sizeof(B8gEsVm));
    if (!vm) return NULL;
    vm->global_env = env_new(vm, NULL);

    /* console */
    EsObj *console_obj = new_obj(vm);
    obj_set(vm, console_obj, "log", val_native(native_console_log));
    env_define(vm, vm->global_env, "console", val_obj(console_obj), true);

    /* Uint8Array */
    env_define(vm, vm->global_env, "Uint8Array", val_native(native_uint8array), true);

    /* sys */
    EsObj *sys_obj = new_obj(vm);
    obj_set(vm, sys_obj, "platform", val_native(native_sys_platform));
    obj_set(vm, sys_obj, "clockNs", val_native(native_sys_clock_ns));
    obj_set(vm, sys_obj, "readFile", val_native(native_sys_read_file));
    obj_set(vm, sys_obj, "writeFile", val_native(native_sys_write_file));
    env_define(vm, vm->global_env, "sys", val_obj(sys_obj), true);

    return vm;
}

int b8g_es_eval(B8gEsVm *vm, const char *source, const char *filename,
                char *out_buf, size_t out_cap) {
    (void)filename;
    if (!vm || !source) return 1;
    vm->signal = SIG_NONE;
    vm->signal_val = val_undef();
    vm->error[0] = '\0';
    vm->did_print = 0;

    Parser p;
    memset(&p, 0, sizeof(p));
    p.vm = vm;
    p.src = source;
    p.line = 1;
    next_token(&p);

    int cap = 32, count = 0;
    Stmt **stmts = (Stmt **)malloc(sizeof(Stmt *) * (size_t)cap);
    while (p.cur.kind != TOK_EOF && !p.has_error) {
        if (count >= cap) { cap *= 2; stmts = (Stmt **)realloc(stmts, sizeof(Stmt *) * (size_t)cap); }
        stmts[count++] = parse_stmt(&p);
    }

    if (p.has_error || vm->signal == SIG_ERROR) {
        free(stmts);
        return 1;
    }

    /* Hoist top-level function declarations */
    for (int i = 0; i < count; i++) {
        if (stmts[i] && stmts[i]->kind == STMT_FN) {
            Stmt *st = stmts[i];
            EsFn *f = new_fn(vm, st->as.fn.name, st->as.fn.param_count,
                             st->as.fn.params, st->as.fn.body, vm->global_env);
            env_define(vm, vm->global_env, st->as.fn.name, val_fn(f), false);
        }
    }

    EsVal last = val_undef();
    for (int i = 0; i < count; i++) {
        if (!stmts[i] || stmts[i]->kind == STMT_FN) continue;
        last = eval_stmt(vm, vm->global_env, stmts[i]);
        if (vm->signal != SIG_NONE) break;
    }
    free(stmts);

    if (vm->signal == SIG_ERROR) return 1;

    if (out_buf && out_cap > 0) {
        if (last.kind == VAL_UNDEFINED) {
            out_buf[0] = '\0';
        } else {
            EsStr *s = val_to_str(vm, last);
            if (s) {
                size_t n = s->len < out_cap - 1 ? s->len : out_cap - 1;
                memcpy(out_buf, s->data, n);
                out_buf[n] = '\0';
            } else {
                out_buf[0] = '\0';
            }
        }
    }
    return 0;
}

void b8g_es_destroy(B8gEsVm *vm) {
    if (!vm) return;

    /* Release function closures before freeing heap objects */
    for (HeapObj *h = vm->heap_head; h; h = h->next) {
        if (h->kind == HEAP_FN) {
            EsFn *f = (EsFn *)h;
            if (f->closure) {
                env_release(vm, f->closure);
                f->closure = NULL;
            }
        }
    }
    if (vm->global_env) {
        env_release(vm, vm->global_env);
        vm->global_env = NULL;
    }

    HeapObj *h = vm->heap_head;
    while (h) {
        HeapObj *next = h->next;
        switch (h->kind) {
            case HEAP_STR:
                free(((EsStr *)h)->data);
                break;
            case HEAP_ARR:
                free(((EsArr *)h)->items);
                break;
            case HEAP_OBJ: {
                EsObj *o = (EsObj *)h;
                for (size_t i = 0; i < o->len; i++) free(o->props[i].key);
                free(o->props);
                break;
            }
            case HEAP_U8ARR:
                free(((EsU8Arr *)h)->data);
                break;
            case HEAP_FN:
                break;
        }
        free(h);
        h = next;
    }

    EsEnv *fe = vm->free_envs;
    while (fe) {
        EsEnv *next = fe->free_next;
        free(fe);
        fe = next;
    }

    arena_free(&vm->ast_arena);
    free(vm);
}

const char *b8g_es_last_error(const B8gEsVm *vm) {
    return vm ? vm->error : "";
}

int b8g_es_did_print(const B8gEsVm *vm) {
    return vm ? vm->did_print : 0;
}
