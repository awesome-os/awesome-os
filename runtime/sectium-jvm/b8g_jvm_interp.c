#define _POSIX_C_SOURCE 200809L

#include "b8g_jvm.h"

#include <inttypes.h>
#include <limits.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <time.h>
#endif

/* ---- Timing ---- */

int64_t b8g_jvm_nanotime(void) {
#if defined(_WIN32)
  static LARGE_INTEGER freq = {0};
  LARGE_INTEGER counter;
  if (freq.QuadPart == 0) {
    QueryPerformanceFrequency(&freq);
  }
  QueryPerformanceCounter(&counter);
  if (freq.QuadPart == 0) return 0;
  /* Avoid overflow: split seconds and remainder */
  int64_t secs = counter.QuadPart / freq.QuadPart;
  int64_t rem = counter.QuadPart % freq.QuadPart;
  return secs * 1000000000LL + (rem * 1000000000LL) / freq.QuadPart;
#elif defined(__wasi__)
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) == 0) {
    return (int64_t)ts.tv_sec * 1000000000LL + (int64_t)ts.tv_nsec;
  }
  return 0;
#else
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000000000LL + (int64_t)ts.tv_nsec;
#endif
}

/* ---- Error formatting ---- */

static void set_err(char *buf, size_t cap, const char *fmt, ...) {
  if (!buf || cap == 0) return;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, cap, fmt, ap);
  va_end(ap);
}

/* ---- Binary reader ---- */

typedef struct {
  const uint8_t *data;
  size_t len;
  size_t pos;
} b8g_reader_t;

static int rd_u1(b8g_reader_t *r, uint8_t *v) {
  if (r->pos + 1 > r->len) return -1;
  *v = r->data[r->pos++];
  return 0;
}

static int rd_u2(b8g_reader_t *r, uint16_t *v) {
  if (r->pos + 2 > r->len) return -1;
  *v = (uint16_t)(((uint16_t)r->data[r->pos] << 8) | r->data[r->pos + 1]);
  r->pos += 2;
  return 0;
}

static int rd_u4(b8g_reader_t *r, uint32_t *v) {
  if (r->pos + 4 > r->len) return -1;
  *v = ((uint32_t)r->data[r->pos] << 24) |
       ((uint32_t)r->data[r->pos + 1] << 16) |
       ((uint32_t)r->data[r->pos + 2] << 8) |
       (uint32_t)r->data[r->pos + 3];
  r->pos += 4;
  return 0;
}

static int rd_skip(b8g_reader_t *r, size_t n) {
  if (r->pos + n > r->len) return -1;
  r->pos += n;
  return 0;
}

/* ---- Constant pool & descriptor helpers ---- */

const char *b8g_jvm_cp_utf8(const b8g_jvm_class_t *cls, uint16_t idx) {
  if (!cls || idx == 0 || idx >= cls->cp_count) return NULL;
  if (cls->cp[idx].tag != JVM_CP_UTF8) return NULL;
  return cls->cp[idx].u.utf8.str;
}

const char *b8g_jvm_cp_class_name(const b8g_jvm_class_t *cls, uint16_t class_idx) {
  if (!cls || class_idx == 0 || class_idx >= cls->cp_count) return NULL;
  if (cls->cp[class_idx].tag != JVM_CP_CLASS) return NULL;
  return b8g_jvm_cp_utf8(cls, cls->cp[class_idx].u.index1);
}

int b8g_jvm_cp_member(const b8g_jvm_class_t *cls, uint16_t ref_idx,
                      const char **out_cls, const char **out_name,
                      const char **out_desc) {
  if (!cls || ref_idx == 0 || ref_idx >= cls->cp_count) return -1;
  uint8_t tag = cls->cp[ref_idx].tag;
  if (tag != JVM_CP_FIELDREF && tag != JVM_CP_METHODREF &&
      tag != JVM_CP_IFMETHODREF) {
    return -1;
  }
  uint16_t cidx = cls->cp[ref_idx].u.ref.class_index;
  uint16_t nidx = cls->cp[ref_idx].u.ref.nat_index;
  if (nidx == 0 || nidx >= cls->cp_count ||
      cls->cp[nidx].tag != JVM_CP_NAMEANDTYPE) {
    return -1;
  }
  const char *cn = b8g_jvm_cp_class_name(cls, cidx);
  const char *mn = b8g_jvm_cp_utf8(cls, cls->cp[nidx].u.nat.name_index);
  const char *md = b8g_jvm_cp_utf8(cls, cls->cp[nidx].u.nat.desc_index);
  if (!cn || !mn || !md) return -1;
  if (out_cls) *out_cls = cn;
  if (out_name) *out_name = mn;
  if (out_desc) *out_desc = md;
  return 0;
}

const b8g_method_t *b8g_jvm_find_method(const b8g_jvm_class_t *cls,
                                        const char *name, const char *desc) {
  if (!cls || !name) return NULL;
  for (uint16_t i = 0; i < cls->methods_count; i++) {
    if (cls->methods[i].name && strcmp(cls->methods[i].name, name) == 0) {
      if (!desc ||
          (cls->methods[i].desc && strcmp(cls->methods[i].desc, desc) == 0)) {
        return &cls->methods[i];
      }
    }
  }
  return NULL;
}

static char parse_desc_type(const char **pp) {
  const char *p = *pp;
  if (!*p) return 0;
  char c = *p++;
  switch (c) {
    case 'B':
    case 'C':
    case 'I':
    case 'S':
    case 'Z':
      *pp = p;
      return 'I';
    case 'J':
      *pp = p;
      return 'J';
    case 'F':
      *pp = p;
      return 'F';
    case 'D':
      *pp = p;
      return 'D';
    case 'V':
      *pp = p;
      return 'V';
    case 'L':
      while (*p && *p != ';') p++;
      if (*p != ';') return 0;
      *pp = p + 1;
      return 'L';
    case '[':
      while (*p == '[') p++;
      if (*p == 'L') {
        while (*p && *p != ';') p++;
        if (*p != ';') return 0;
        p++;
      } else if (*p) {
        p++;
      } else {
        return 0;
      }
      *pp = p;
      return 'L';
    default:
      return 0;
  }
}

int b8g_jvm_desc_arg_info(const char *desc, char *arg_types, int max_args,
                          char *ret_type) {
  if (!desc || *desc != '(') return -1;
  const char *p = desc + 1;
  int count = 0;
  while (*p && *p != ')') {
    char t = parse_desc_type(&p);
    if (!t || t == 'V') return -1;
    if (arg_types && count < max_args) {
      arg_types[count] = t;
    }
    count++;
  }
  if (*p != ')') return -1;
  p++;
  char rt = parse_desc_type(&p);
  if (!rt) return -1;
  if (ret_type) *ret_type = rt;
  return count;
}

/* ---- .class binary parser ---- */

static int skip_attributes(b8g_reader_t *r) {
  uint16_t count = 0;
  if (rd_u2(r, &count) != 0) return -1;
  for (uint16_t i = 0; i < count; i++) {
    uint16_t name_idx = 0;
    uint32_t attr_len = 0;
    if (rd_u2(r, &name_idx) != 0 || rd_u4(r, &attr_len) != 0) return -1;
    if (rd_skip(r, attr_len) != 0) return -1;
  }
  return 0;
}

void b8g_jvm_free_class(b8g_jvm_class_t *cls) {
  if (!cls) return;
  if (cls->cp) {
    for (uint16_t i = 1; i < cls->cp_count; i++) {
      if (cls->cp[i].tag == JVM_CP_UTF8 && cls->cp[i].u.utf8.str) {
        free(cls->cp[i].u.utf8.str);
      }
    }
    free(cls->cp);
  }
  if (cls->methods) {
    for (uint16_t i = 0; i < cls->methods_count; i++) {
      free(cls->methods[i].code);
    }
    free(cls->methods);
  }
  memset(cls, 0, sizeof(*cls));
}

int b8g_jvm_parse_class(const uint8_t *data, size_t len,
                        b8g_jvm_class_t *out, char *err, size_t err_cap) {
  memset(out, 0, sizeof(*out));
  b8g_reader_t r = {data, len, 0};

  uint32_t magic = 0;
  if (rd_u4(&r, &magic) != 0 || magic != 0xCAFEBABEu) {
    set_err(err, err_cap, "invalid class magic: 0x%08" PRIX32, magic);
    return -1;
  }
  if (rd_u2(&r, &out->minor_version) != 0 ||
      rd_u2(&r, &out->major_version) != 0 ||
      rd_u2(&r, &out->cp_count) != 0) {
    set_err(err, err_cap, "truncated class header");
    return -1;
  }
  if (out->cp_count < 1) {
    set_err(err, err_cap, "invalid constant pool count: 0");
    return -1;
  }

  out->cp = (b8g_cp_entry_t *)calloc(out->cp_count, sizeof(b8g_cp_entry_t));
  if (!out->cp) {
    set_err(err, err_cap, "out of memory allocating constant pool");
    return -1;
  }

  for (uint16_t i = 1; i < out->cp_count; i++) {
    uint8_t tag = 0;
    if (rd_u1(&r, &tag) != 0) {
      set_err(err, err_cap, "truncated constant pool at #%u", i);
      goto fail;
    }
    out->cp[i].tag = tag;
    switch (tag) {
      case JVM_CP_UTF8: {
        uint16_t slen = 0;
        if (rd_u2(&r, &slen) != 0 || r.pos + slen > r.len) {
          set_err(err, err_cap, "truncated Utf8 at #%u", i);
          goto fail;
        }
        char *s = (char *)malloc((size_t)slen + 1);
        if (!s) {
          set_err(err, err_cap, "out of memory for Utf8");
          goto fail;
        }
        memcpy(s, r.data + r.pos, slen);
        s[slen] = '\0';
        r.pos += slen;
        out->cp[i].u.utf8.str = s;
        out->cp[i].u.utf8.len = slen;
        break;
      }
      case JVM_CP_INTEGER: {
        uint32_t bits = 0;
        if (rd_u4(&r, &bits) != 0) goto fail_cp;
        out->cp[i].u.i32 = (int32_t)bits;
        break;
      }
      case JVM_CP_FLOAT: {
        uint32_t bits = 0;
        if (rd_u4(&r, &bits) != 0) goto fail_cp;
        memcpy(&out->cp[i].u.f32, &bits, sizeof(float));
        break;
      }
      case JVM_CP_LONG: {
        uint32_t hi = 0, lo = 0;
        if (rd_u4(&r, &hi) != 0 || rd_u4(&r, &lo) != 0) goto fail_cp;
        out->cp[i].u.i64 = (int64_t)(((uint64_t)hi << 32) | lo);
        i++; /* Long takes 2 slots */
        break;
      }
      case JVM_CP_DOUBLE: {
        uint32_t hi = 0, lo = 0;
        if (rd_u4(&r, &hi) != 0 || rd_u4(&r, &lo) != 0) goto fail_cp;
        uint64_t bits = ((uint64_t)hi << 32) | lo;
        memcpy(&out->cp[i].u.f64, &bits, sizeof(double));
        i++; /* Double takes 2 slots */
        break;
      }
      case JVM_CP_CLASS:
      case JVM_CP_STRING:
      case JVM_CP_METHODTYPE:
      case JVM_CP_MODULE:
      case JVM_CP_PACKAGE: {
        if (rd_u2(&r, &out->cp[i].u.index1) != 0) goto fail_cp;
        break;
      }
      case JVM_CP_FIELDREF:
      case JVM_CP_METHODREF:
      case JVM_CP_IFMETHODREF: {
        if (rd_u2(&r, &out->cp[i].u.ref.class_index) != 0 ||
            rd_u2(&r, &out->cp[i].u.ref.nat_index) != 0) {
          goto fail_cp;
        }
        break;
      }
      case JVM_CP_NAMEANDTYPE: {
        if (rd_u2(&r, &out->cp[i].u.nat.name_index) != 0 ||
            rd_u2(&r, &out->cp[i].u.nat.desc_index) != 0) {
          goto fail_cp;
        }
        break;
      }
      case JVM_CP_METHODHANDLE: {
        if (rd_skip(&r, 3) != 0) goto fail_cp;
        break;
      }
      case JVM_CP_DYNAMIC:
      case JVM_CP_INVOKEDYN: {
        if (rd_skip(&r, 4) != 0) goto fail_cp;
        break;
      }
      default:
        set_err(err, err_cap, "unsupported constant pool tag %u at #%u", tag, i);
        goto fail;
    }
  }

  if (rd_u2(&r, &out->access_flags) != 0 ||
      rd_u2(&r, &out->this_class) != 0 ||
      rd_u2(&r, &out->super_class) != 0) {
    set_err(err, err_cap, "truncated class metadata");
    goto fail;
  }
  out->this_name = b8g_jvm_cp_class_name(out, out->this_class);

  /* Interfaces */
  uint16_t iface_count = 0;
  if (rd_u2(&r, &iface_count) != 0 ||
      rd_skip(&r, (size_t)iface_count * 2) != 0) {
    set_err(err, err_cap, "truncated interfaces");
    goto fail;
  }

  /* Fields */
  uint16_t fields_count = 0;
  if (rd_u2(&r, &fields_count) != 0) {
    set_err(err, err_cap, "truncated fields count");
    goto fail;
  }
  for (uint16_t i = 0; i < fields_count; i++) {
    if (rd_skip(&r, 6) != 0 || skip_attributes(&r) != 0) {
      set_err(err, err_cap, "truncated field #%u", i);
      goto fail;
    }
  }

  /* Methods */
  if (rd_u2(&r, &out->methods_count) != 0) {
    set_err(err, err_cap, "truncated methods count");
    goto fail;
  }
  if (out->methods_count > 0) {
    out->methods =
        (b8g_method_t *)calloc(out->methods_count, sizeof(b8g_method_t));
    if (!out->methods) {
      set_err(err, err_cap, "out of memory allocating methods");
      goto fail;
    }
  }

  for (uint16_t i = 0; i < out->methods_count; i++) {
    b8g_method_t *m = &out->methods[i];
    uint16_t attr_count = 0;
    if (rd_u2(&r, &m->access_flags) != 0 ||
        rd_u2(&r, &m->name_index) != 0 ||
        rd_u2(&r, &m->desc_index) != 0 ||
        rd_u2(&r, &attr_count) != 0) {
      set_err(err, err_cap, "truncated method #%u", i);
      goto fail;
    }
    m->name = b8g_jvm_cp_utf8(out, m->name_index);
    m->desc = b8g_jvm_cp_utf8(out, m->desc_index);

    for (uint16_t a = 0; a < attr_count; a++) {
      uint16_t aname_idx = 0;
      uint32_t alen = 0;
      if (rd_u2(&r, &aname_idx) != 0 || rd_u4(&r, &alen) != 0) {
        set_err(err, err_cap, "truncated method attribute");
        goto fail;
      }
      const char *aname = b8g_jvm_cp_utf8(out, aname_idx);
      if (aname && strcmp(aname, "Code") == 0) {
        size_t attr_end = r.pos + alen;
        if (attr_end > r.len) {
          set_err(err, err_cap, "truncated Code attribute");
          goto fail;
        }
        if (rd_u2(&r, &m->max_stack) != 0 ||
            rd_u2(&r, &m->max_locals) != 0 ||
            rd_u4(&r, &m->code_len) != 0 ||
            r.pos + m->code_len > attr_end) {
          set_err(err, err_cap, "malformed Code attribute");
          goto fail;
        }
        m->code = (uint8_t *)malloc(m->code_len > 0 ? m->code_len : 1);
        if (!m->code) {
          set_err(err, err_cap, "out of memory allocating bytecode");
          goto fail;
        }
        if (m->code_len > 0) {
          memcpy(m->code, r.data + r.pos, m->code_len);
        }
        m->has_code = 1;
        r.pos = attr_end;
      } else {
        if (rd_skip(&r, alen) != 0) {
          set_err(err, err_cap, "truncated method attribute payload");
          goto fail;
        }
      }
    }
  }

  return 0;

fail_cp:
  set_err(err, err_cap, "truncated constant pool entry");
fail:
  b8g_jvm_free_class(out);
  return -1;
}

/* ---- VM Lifecycle & Heap ---- */

void b8g_jvm_vm_init(b8g_jvm_vm_t *vm, const b8g_jvm_class_t *cls) {
  memset(vm, 0, sizeof(*vm));
  vm->cls = cls;
  vm->max_call_depth = 4096;
}

void b8g_jvm_vm_free(b8g_jvm_vm_t *vm) {
  if (!vm) return;
  b8g_array_t *cur = vm->heap_head;
  while (cur) {
    b8g_array_t *next = cur->next;
    free(cur->data);
    free(cur);
    cur = next;
  }
  vm->heap_head = NULL;
  free(vm->objects);
  vm->objects = NULL;
  vm->obj_count = 0;
  vm->static_count = 0;
}

static uintptr_t vm_alloc_object(b8g_jvm_vm_t *vm, uint16_t class_idx) {
  if (!vm->objects) {
    vm->objects =
        (b8g_jvm_obj_t *)calloc(B8G_JVM_MAX_OBJECTS, sizeof(b8g_jvm_obj_t));
    if (!vm->objects) {
      set_err(vm->err, sizeof(vm->err), "OutOfMemoryError (object arena)");
      return 0;
    }
  }
  if (vm->obj_count >= B8G_JVM_MAX_OBJECTS) {
    set_err(vm->err, sizeof(vm->err), "OutOfMemoryError (max %d objects)",
            B8G_JVM_MAX_OBJECTS);
    return 0;
  }
  uint32_t id = ++vm->obj_count; /* 1-based handle so 0 == null */
  b8g_jvm_obj_t *obj = &vm->objects[id - 1];
  memset(obj, 0, sizeof(*obj));
  obj->class_idx = class_idx;
  return (uintptr_t)id;
}

static int vm_putfield(b8g_jvm_vm_t *vm, void *ref, uint16_t field_cp_idx,
                       int64_t val) {
  uintptr_t id = (uintptr_t)ref;
  if (id == 0 || id > vm->obj_count || !vm->objects) {
    set_err(vm->err, sizeof(vm->err), "NullPointerException in putfield #%u",
            field_cp_idx);
    return -1;
  }
  b8g_jvm_obj_t *obj = &vm->objects[id - 1];
  for (uint8_t i = 0; i < obj->field_count; i++) {
    if (obj->field_keys[i] == field_cp_idx) {
      obj->field_vals[i] = val;
      return 0;
    }
  }
  if (obj->field_count >= B8G_JVM_MAX_OBJ_FIELDS) {
    set_err(vm->err, sizeof(vm->err), "object field limit (%d) exceeded",
            B8G_JVM_MAX_OBJ_FIELDS);
    return -1;
  }
  uint8_t slot = obj->field_count++;
  obj->field_keys[slot] = field_cp_idx;
  obj->field_vals[slot] = val;
  return 0;
}

static int vm_getfield(b8g_jvm_vm_t *vm, void *ref, uint16_t field_cp_idx,
                       int64_t *out_val) {
  uintptr_t id = (uintptr_t)ref;
  if (id == 0 || id > vm->obj_count || !vm->objects) {
    set_err(vm->err, sizeof(vm->err), "NullPointerException in getfield #%u",
            field_cp_idx);
    return -1;
  }
  b8g_jvm_obj_t *obj = &vm->objects[id - 1];
  for (uint8_t i = 0; i < obj->field_count; i++) {
    if (obj->field_keys[i] == field_cp_idx) {
      *out_val = obj->field_vals[i];
      return 0;
    }
  }
  *out_val = 0;
  return 0;
}

static int vm_putstatic(b8g_jvm_vm_t *vm, uint16_t field_cp_idx, int64_t val) {
  for (uint16_t i = 0; i < vm->static_count; i++) {
    if (vm->statics[i].key == field_cp_idx) {
      vm->statics[i].val = val;
      return 0;
    }
  }
  if (vm->static_count >= B8G_JVM_MAX_STATICS) {
    set_err(vm->err, sizeof(vm->err), "static field limit (%d) exceeded",
            B8G_JVM_MAX_STATICS);
    return -1;
  }
  vm->statics[vm->static_count].key = field_cp_idx;
  vm->statics[vm->static_count].val = val;
  vm->static_count++;
  return 0;
}

static int64_t vm_getstatic(b8g_jvm_vm_t *vm, uint16_t field_cp_idx) {
  for (uint16_t i = 0; i < vm->static_count; i++) {
    if (vm->statics[i].key == field_cp_idx) {
      return vm->statics[i].val;
    }
  }
  return 0;
}

static b8g_array_t *vm_alloc_array(b8g_jvm_vm_t *vm, uint8_t atype,
                                   int32_t count) {
  if (count < 0) {
    set_err(vm->err, sizeof(vm->err), "NegativeArraySizeException: %" PRId32,
            count);
    return NULL;
  }
  size_t elem_size = 4;
  switch (atype) {
    case JVM_T_BOOLEAN:
    case JVM_T_BYTE:
      elem_size = 1;
      break;
    case JVM_T_CHAR:
    case JVM_T_SHORT:
      elem_size = 2;
      break;
    case JVM_T_INT:
    case JVM_T_FLOAT:
      elem_size = 4;
      break;
    case JVM_T_LONG:
    case JVM_T_DOUBLE:
      elem_size = 8;
      break;
    default:
      set_err(vm->err, sizeof(vm->err), "unsupported newarray atype %u", atype);
      return NULL;
  }
  b8g_array_t *arr = (b8g_array_t *)calloc(1, sizeof(b8g_array_t));
  if (!arr) {
    set_err(vm->err, sizeof(vm->err), "OutOfMemoryError");
    return NULL;
  }
  arr->atype = atype;
  arr->length = count;
  arr->data = calloc(count > 0 ? (size_t)count : 1, elem_size);
  if (!arr->data) {
    free(arr);
    set_err(vm->err, sizeof(vm->err), "OutOfMemoryError");
    return NULL;
  }
  arr->next = vm->heap_head;
  vm->heap_head = arr;
  return arr;
}

/* ---- Tier-0 Bytecode Interpreter ---- */

static inline int16_t read_s16(const uint8_t *code, uint32_t pc) {
  return (int16_t)(((uint16_t)code[pc] << 8) | code[pc + 1]);
}

static inline uint16_t read_u16(const uint8_t *code, uint32_t pc) {
  return (uint16_t)(((uint16_t)code[pc] << 8) | code[pc + 1]);
}

int b8g_jvm_exec_method(b8g_jvm_vm_t *vm, const b8g_method_t *m,
                        const b8g_val_t *args, int arg_count,
                        b8g_val_t *ret_val) {
  if (!m || !m->has_code) {
    set_err(vm->err, sizeof(vm->err), "method has no Code attribute");
    return -1;
  }
  if (vm->call_depth >= vm->max_call_depth) {
    set_err(vm->err, sizeof(vm->err), "StackOverflowError in %s",
            m->name ? m->name : "<unknown>");
    return -1;
  }

  /* Stack-allocate fast frame for typical methods; heap fallback for huge ones */
  b8g_val_t fast_locals[64];
  b8g_val_t fast_stack[64];
  uint16_t nlocals = m->max_locals < 8 ? 8 : m->max_locals;
  uint16_t nstack = m->max_stack < 8 ? 8 : m->max_stack;
  b8g_val_t *locals = fast_locals;
  b8g_val_t *stack = fast_stack;
  int heap_locals = 0, heap_stack = 0;

  if (nlocals > 64) {
    locals = (b8g_val_t *)calloc(nlocals, sizeof(b8g_val_t));
    if (!locals) {
      set_err(vm->err, sizeof(vm->err), "OutOfMemoryError (locals)");
      return -1;
    }
    heap_locals = 1;
  } else {
    memset(locals, 0, nlocals * sizeof(b8g_val_t));
  }

  if (nstack > 64) {
    stack = (b8g_val_t *)calloc(nstack, sizeof(b8g_val_t));
    if (!stack) {
      if (heap_locals) free(locals);
      set_err(vm->err, sizeof(vm->err), "OutOfMemoryError (stack)");
      return -1;
    }
    heap_stack = 1;
  }

  /* Copy arguments into local slots (respecting 2-slot long/double and 'this') */
  char arg_types[64];
  char ret_type = 'V';
  int desc_argc = b8g_jvm_desc_arg_info(m->desc, arg_types, 64, &ret_type);
  int is_static = (m->access_flags & JVM_ACC_STATIC) != 0;
  int slot = 0;
  for (int i = 0; i < arg_count && slot < (int)nlocals; i++) {
    locals[slot] = args[i];
    if (!is_static && i == 0) {
      slot += 1;
    } else {
      int di = is_static ? i : (i - 1);
      if (desc_argc > 0 && di >= 0 && di < desc_argc &&
          (arg_types[di] == 'J' || arg_types[di] == 'D')) {
        slot += 2;
      } else {
        slot += 1;
      }
    }
  }

  vm->call_depth++;
  const b8g_jvm_class_t *cls = vm->cls;
  const uint8_t *code = m->code;
  uint32_t code_len = m->code_len;
  uint32_t pc = 0;
  int sp = 0;
  int status = 0;

#define PUSH_I32(v) do { stack[sp].i64 = 0; stack[sp++].i32 = (int32_t)(v); } while (0)
#define PUSH_I64(v) do { stack[sp++].i64 = (int64_t)(v); } while (0)
#define PUSH_REF(v) do { stack[sp].i64 = 0; stack[sp++].ref = (void *)(v); } while (0)
#define POP_I32()   (stack[--sp].i32)
#define POP_I64()   (stack[--sp].i64)
#define POP_REF()   (stack[--sp].ref)

  while (pc < code_len) {
    uint32_t op_pc = pc;
    uint8_t op = code[pc++];

    switch (op) {
      /* ---- Constants ---- */
      case 0x00: /* nop */
        break;
      case 0x01: /* aconst_null */
        PUSH_REF(NULL);
        break;
      case 0x02: PUSH_I32(-1); break; /* iconst_m1 */
      case 0x03: PUSH_I32(0); break;  /* iconst_0 */
      case 0x04: PUSH_I32(1); break;  /* iconst_1 */
      case 0x05: PUSH_I32(2); break;  /* iconst_2 */
      case 0x06: PUSH_I32(3); break;  /* iconst_3 */
      case 0x07: PUSH_I32(4); break;  /* iconst_4 */
      case 0x08: PUSH_I32(5); break;  /* iconst_5 */
      case 0x09: PUSH_I64(0); break;  /* lconst_0 */
      case 0x0a: PUSH_I64(1); break;  /* lconst_1 */
      case 0x10: { /* bipush */
        int8_t b = (int8_t)code[pc++];
        PUSH_I32((int32_t)b);
        break;
      }
      case 0x11: { /* sipush */
        int16_t s = read_s16(code, pc);
        pc += 2;
        PUSH_I32((int32_t)s);
        break;
      }
      case 0x12: /* ldc */
      case 0x13: /* ldc_w */ {
        uint16_t idx = (op == 0x12) ? (uint16_t)code[pc++] : read_u16(code, pc);
        if (op == 0x13) pc += 2;
        if (idx == 0 || idx >= cls->cp_count) {
          set_err(vm->err, sizeof(vm->err), "bad ldc index %u", idx);
          status = -1;
          goto done;
        }
        b8g_cp_entry_t *e = &cls->cp[idx];
        if (e->tag == JVM_CP_INTEGER) {
          PUSH_I32(e->u.i32);
        } else if (e->tag == JVM_CP_STRING) {
          const char *s = b8g_jvm_cp_utf8(cls, e->u.index1);
          PUSH_REF(s ? (void *)s : (void *)"");
        } else if (e->tag == JVM_CP_FLOAT) {
          int32_t bits = 0;
          memcpy(&bits, &e->u.f32, 4);
          PUSH_I32(bits);
        } else {
          set_err(vm->err, sizeof(vm->err), "unsupported ldc tag %u", e->tag);
          status = -1;
          goto done;
        }
        break;
      }
      case 0x14: { /* ldc2_w */
        uint16_t idx = read_u16(code, pc);
        pc += 2;
        if (idx == 0 || idx >= cls->cp_count ||
            cls->cp[idx].tag != JVM_CP_LONG) {
          set_err(vm->err, sizeof(vm->err), "bad ldc2_w index %u", idx);
          status = -1;
          goto done;
        }
        PUSH_I64(cls->cp[idx].u.i64);
        break;
      }

      /* ---- Locals: loads ---- */
      case 0x15: PUSH_I32(locals[code[pc++]].i32); break; /* iload */
      case 0x16: PUSH_I64(locals[code[pc++]].i64); break; /* lload */
      case 0x19: PUSH_REF(locals[code[pc++]].ref); break; /* aload */
      case 0x1a: PUSH_I32(locals[0].i32); break; /* iload_0 */
      case 0x1b: PUSH_I32(locals[1].i32); break; /* iload_1 */
      case 0x1c: PUSH_I32(locals[2].i32); break; /* iload_2 */
      case 0x1d: PUSH_I32(locals[3].i32); break; /* iload_3 */
      case 0x1e: PUSH_I64(locals[0].i64); break; /* lload_0 */
      case 0x1f: PUSH_I64(locals[1].i64); break; /* lload_1 */
      case 0x20: PUSH_I64(locals[2].i64); break; /* lload_2 */
      case 0x21: PUSH_I64(locals[3].i64); break; /* lload_3 */
      case 0x2a: PUSH_REF(locals[0].ref); break; /* aload_0 */
      case 0x2b: PUSH_REF(locals[1].ref); break; /* aload_1 */
      case 0x2c: PUSH_REF(locals[2].ref); break; /* aload_2 */
      case 0x2d: PUSH_REF(locals[3].ref); break; /* aload_3 */

      /* ---- Array loads ---- */
      case 0x2e: { /* iaload */
        int32_t idx = POP_I32();
        b8g_array_t *arr = (b8g_array_t *)POP_REF();
        if (!arr || idx < 0 || idx >= arr->length) {
          set_err(vm->err, sizeof(vm->err), "iaload out of bounds: %" PRId32, idx);
          status = -1;
          goto done;
        }
        PUSH_I32(((int32_t *)arr->data)[idx]);
        break;
      }
      case 0x33: { /* baload */
        int32_t idx = POP_I32();
        b8g_array_t *arr = (b8g_array_t *)POP_REF();
        if (!arr || idx < 0 || idx >= arr->length) {
          set_err(vm->err, sizeof(vm->err), "baload out of bounds: %" PRId32, idx);
          status = -1;
          goto done;
        }
        PUSH_I32((int32_t)((int8_t *)arr->data)[idx]);
        break;
      }

      /* ---- Locals: stores ---- */
      case 0x36: locals[code[pc++]].i32 = POP_I32(); break; /* istore */
      case 0x37: locals[code[pc++]].i64 = POP_I64(); break; /* lstore */
      case 0x3a: locals[code[pc++]].ref = POP_REF(); break; /* astore */
      case 0x3b: locals[0].i32 = POP_I32(); break; /* istore_0 */
      case 0x3c: locals[1].i32 = POP_I32(); break; /* istore_1 */
      case 0x3d: locals[2].i32 = POP_I32(); break; /* istore_2 */
      case 0x3e: locals[3].i32 = POP_I32(); break; /* istore_3 */
      case 0x3f: locals[0].i64 = POP_I64(); break; /* lstore_0 */
      case 0x40: locals[1].i64 = POP_I64(); break; /* lstore_1 */
      case 0x41: locals[2].i64 = POP_I64(); break; /* lstore_2 */
      case 0x42: locals[3].i64 = POP_I64(); break; /* lstore_3 */
      case 0x4b: locals[0].ref = POP_REF(); break; /* astore_0 */
      case 0x4c: locals[1].ref = POP_REF(); break; /* astore_1 */
      case 0x4d: locals[2].ref = POP_REF(); break; /* astore_2 */
      case 0x4e: locals[3].ref = POP_REF(); break; /* astore_3 */

      /* ---- Array stores ---- */
      case 0x4f: { /* iastore */
        int32_t val = POP_I32();
        int32_t idx = POP_I32();
        b8g_array_t *arr = (b8g_array_t *)POP_REF();
        if (!arr || idx < 0 || idx >= arr->length) {
          set_err(vm->err, sizeof(vm->err), "iastore out of bounds: %" PRId32, idx);
          status = -1;
          goto done;
        }
        ((int32_t *)arr->data)[idx] = val;
        break;
      }
      case 0x54: { /* bastore */
        int32_t val = POP_I32();
        int32_t idx = POP_I32();
        b8g_array_t *arr = (b8g_array_t *)POP_REF();
        if (!arr || idx < 0 || idx >= arr->length) {
          set_err(vm->err, sizeof(vm->err), "bastore out of bounds: %" PRId32, idx);
          status = -1;
          goto done;
        }
        ((int8_t *)arr->data)[idx] = (int8_t)val;
        break;
      }

      /* ---- Stack ---- */
      case 0x57: /* pop */
        sp--;
        break;
      case 0x58: /* pop2 */
        sp -= (sp >= 2 ? 2 : 1);
        break;
      case 0x59: /* dup */
        stack[sp] = stack[sp - 1];
        sp++;
        break;
      case 0x5f: { /* swap */
        b8g_val_t tmp = stack[sp - 1];
        stack[sp - 1] = stack[sp - 2];
        stack[sp - 2] = tmp;
        break;
      }

      /* ---- Int / Long Arithmetic & Bitwise ---- */
      case 0x60: { /* iadd */
        int32_t b = POP_I32(), a = POP_I32();
        PUSH_I32((int32_t)((uint32_t)a + (uint32_t)b));
        break;
      }
      case 0x61: { /* ladd */
        int64_t b = POP_I64(), a = POP_I64();
        PUSH_I64((int64_t)((uint64_t)a + (uint64_t)b));
        break;
      }
      case 0x64: { /* isub */
        int32_t b = POP_I32(), a = POP_I32();
        PUSH_I32((int32_t)((uint32_t)a - (uint32_t)b));
        break;
      }
      case 0x65: { /* lsub */
        int64_t b = POP_I64(), a = POP_I64();
        PUSH_I64((int64_t)((uint64_t)a - (uint64_t)b));
        break;
      }
      case 0x68: { /* imul */
        int32_t b = POP_I32(), a = POP_I32();
        PUSH_I32((int32_t)((uint32_t)a * (uint32_t)b));
        break;
      }
      case 0x69: { /* lmul */
        int64_t b = POP_I64(), a = POP_I64();
        PUSH_I64((int64_t)((uint64_t)a * (uint64_t)b));
        break;
      }
      case 0x6c: { /* idiv */
        int32_t b = POP_I32(), a = POP_I32();
        if (b == 0) {
          set_err(vm->err, sizeof(vm->err), "ArithmeticException: / by zero");
          status = -1;
          goto done;
        }
        PUSH_I32((a == INT32_MIN && b == -1) ? INT32_MIN : (a / b));
        break;
      }
      case 0x6d: { /* ldiv */
        int64_t b = POP_I64(), a = POP_I64();
        if (b == 0) {
          set_err(vm->err, sizeof(vm->err), "ArithmeticException: / by zero");
          status = -1;
          goto done;
        }
        PUSH_I64((a == INT64_MIN && b == -1) ? INT64_MIN : (a / b));
        break;
      }
      case 0x70: { /* irem */
        int32_t b = POP_I32(), a = POP_I32();
        if (b == 0) {
          set_err(vm->err, sizeof(vm->err), "ArithmeticException: %% by zero");
          status = -1;
          goto done;
        }
        PUSH_I32((a == INT32_MIN && b == -1) ? 0 : (a % b));
        break;
      }
      case 0x71: { /* lrem */
        int64_t b = POP_I64(), a = POP_I64();
        if (b == 0) {
          set_err(vm->err, sizeof(vm->err), "ArithmeticException: %% by zero");
          status = -1;
          goto done;
        }
        PUSH_I64((a == INT64_MIN && b == -1) ? 0 : (a % b));
        break;
      }
      case 0x74: { /* ineg */
        int32_t a = POP_I32();
        PUSH_I32((int32_t)(-(uint32_t)a));
        break;
      }
      case 0x75: { /* lneg */
        int64_t a = POP_I64();
        PUSH_I64((int64_t)(-(uint64_t)a));
        break;
      }
      case 0x78: { /* ishl */
        int32_t b = POP_I32(), a = POP_I32();
        PUSH_I32((int32_t)((uint32_t)a << (b & 0x1f)));
        break;
      }
      case 0x7a: { /* ishr */
        int32_t b = POP_I32(), a = POP_I32();
        PUSH_I32(a >> (b & 0x1f));
        break;
      }
      case 0x7c: { /* iushr */
        int32_t b = POP_I32(), a = POP_I32();
        PUSH_I32((int32_t)((uint32_t)a >> (b & 0x1f)));
        break;
      }
      case 0x7e: { /* iand */
        int32_t b = POP_I32(), a = POP_I32();
        PUSH_I32(a & b);
        break;
      }
      case 0x80: { /* ior */
        int32_t b = POP_I32(), a = POP_I32();
        PUSH_I32(a | b);
        break;
      }
      case 0x82: { /* ixor */
        int32_t b = POP_I32(), a = POP_I32();
        PUSH_I32(a ^ b);
        break;
      }
      case 0x84: { /* iinc */
        uint8_t idx = code[pc++];
        int8_t delta = (int8_t)code[pc++];
        locals[idx].i32 = (int32_t)((uint32_t)locals[idx].i32 + (uint32_t)(int32_t)delta);
        break;
      }
      case 0x85: { /* i2l */
        int32_t a = POP_I32();
        PUSH_I64((int64_t)a);
        break;
      }
      case 0x88: { /* l2i */
        int64_t a = POP_I64();
        PUSH_I32((int32_t)a);
        break;
      }
      case 0x91: { /* i2b */
        int32_t a = POP_I32();
        PUSH_I32((int32_t)(int8_t)a);
        break;
      }
      case 0x92: { /* i2c */
        int32_t a = POP_I32();
        PUSH_I32((int32_t)(uint16_t)a);
        break;
      }
      case 0x93: { /* i2s */
        int32_t a = POP_I32();
        PUSH_I32((int32_t)(int16_t)a);
        break;
      }
      case 0x94: { /* lcmp */
        int64_t b = POP_I64(), a = POP_I64();
        PUSH_I32(a > b ? 1 : (a < b ? -1 : 0));
        break;
      }

      /* ---- Branches ---- */
      case 0x99: { /* ifeq */
        int16_t off = read_s16(code, pc);
        pc += 2;
        if (POP_I32() == 0) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0x9a: { /* ifne */
        int16_t off = read_s16(code, pc);
        pc += 2;
        if (POP_I32() != 0) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0x9b: { /* iflt */
        int16_t off = read_s16(code, pc);
        pc += 2;
        if (POP_I32() < 0) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0x9c: { /* ifge */
        int16_t off = read_s16(code, pc);
        pc += 2;
        if (POP_I32() >= 0) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0x9d: { /* ifgt */
        int16_t off = read_s16(code, pc);
        pc += 2;
        if (POP_I32() > 0) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0x9e: { /* ifle */
        int16_t off = read_s16(code, pc);
        pc += 2;
        if (POP_I32() <= 0) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0x9f: { /* if_icmpeq */
        int16_t off = read_s16(code, pc);
        pc += 2;
        int32_t b = POP_I32(), a = POP_I32();
        if (a == b) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0xa0: { /* if_icmpne */
        int16_t off = read_s16(code, pc);
        pc += 2;
        int32_t b = POP_I32(), a = POP_I32();
        if (a != b) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0xa1: { /* if_icmplt */
        int16_t off = read_s16(code, pc);
        pc += 2;
        int32_t b = POP_I32(), a = POP_I32();
        if (a < b) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0xa2: { /* if_icmpge */
        int16_t off = read_s16(code, pc);
        pc += 2;
        int32_t b = POP_I32(), a = POP_I32();
        if (a >= b) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0xa3: { /* if_icmpgt */
        int16_t off = read_s16(code, pc);
        pc += 2;
        int32_t b = POP_I32(), a = POP_I32();
        if (a > b) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0xa4: { /* if_icmple */
        int16_t off = read_s16(code, pc);
        pc += 2;
        int32_t b = POP_I32(), a = POP_I32();
        if (a <= b) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0xa7: { /* goto */
        int16_t off = read_s16(code, pc);
        pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0xc6: { /* ifnull */
        int16_t off = read_s16(code, pc);
        pc += 2;
        if (POP_REF() == NULL) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }
      case 0xc7: { /* ifnonnull */
        int16_t off = read_s16(code, pc);
        pc += 2;
        if (POP_REF() != NULL) pc = (uint32_t)((int32_t)op_pc + off);
        break;
      }

      /* ---- Returns ---- */
      case 0xac: /* ireturn */
        if (ret_val) {
          ret_val->i64 = 0;
          ret_val->i32 = POP_I32();
        }
        goto done;
      case 0xad: /* lreturn */
        if (ret_val) {
          ret_val->i64 = POP_I64();
        }
        goto done;
      case 0xb0: /* areturn */
        if (ret_val) {
          ret_val->i64 = 0;
          ret_val->ref = POP_REF();
        }
        goto done;
      case 0xb1: /* return */
        goto done;

      /* ---- Field & Method calls ---- */
      case 0xb2: { /* getstatic */
        uint16_t idx = read_u16(code, pc);
        pc += 2;
        const char *cn = NULL, *fn = NULL, *fd = NULL;
        if (b8g_jvm_cp_member(cls, idx, &cn, &fn, &fd) != 0) {
          set_err(vm->err, sizeof(vm->err), "bad getstatic #%u", idx);
          status = -1;
          goto done;
        }
        if (strcmp(cn, "java/lang/System") == 0 && strcmp(fn, "out") == 0) {
          PUSH_REF(JVM_SYSTEM_OUT_REF);
        } else {
          int64_t val = vm_getstatic(vm, idx);
          if (fd[0] == 'J' || fd[0] == 'D') {
            PUSH_I64(val);
          } else if (fd[0] == 'L' || fd[0] == '[') {
            PUSH_REF((void *)(uintptr_t)val);
          } else {
            PUSH_I32((int32_t)val);
          }
        }
        break;
      }
      case 0xb3: { /* putstatic */
        uint16_t idx = read_u16(code, pc);
        pc += 2;
        const char *cn = NULL, *fn = NULL, *fd = NULL;
        if (b8g_jvm_cp_member(cls, idx, &cn, &fn, &fd) != 0) {
          set_err(vm->err, sizeof(vm->err), "bad putstatic #%u", idx);
          status = -1;
          goto done;
        }
        int64_t val = 0;
        if (fd[0] == 'J' || fd[0] == 'D') {
          val = POP_I64();
        } else if (fd[0] == 'L' || fd[0] == '[') {
          val = (int64_t)(uintptr_t)POP_REF();
        } else {
          val = (int64_t)POP_I32();
        }
        if (vm_putstatic(vm, idx, val) != 0) {
          status = -1;
          goto done;
        }
        break;
      }
      case 0xb4: { /* getfield */
        uint16_t idx = read_u16(code, pc);
        pc += 2;
        const char *cn = NULL, *fn = NULL, *fd = NULL;
        if (b8g_jvm_cp_member(cls, idx, &cn, &fn, &fd) != 0) {
          set_err(vm->err, sizeof(vm->err), "bad getfield #%u", idx);
          status = -1;
          goto done;
        }
        void *objref = POP_REF();
        int64_t val = 0;
        if (vm_getfield(vm, objref, idx, &val) != 0) {
          status = -1;
          goto done;
        }
        if (fd[0] == 'J' || fd[0] == 'D') {
          PUSH_I64(val);
        } else if (fd[0] == 'L' || fd[0] == '[') {
          PUSH_REF((void *)(uintptr_t)val);
        } else {
          PUSH_I32((int32_t)val);
        }
        break;
      }
      case 0xb5: { /* putfield */
        uint16_t idx = read_u16(code, pc);
        pc += 2;
        const char *cn = NULL, *fn = NULL, *fd = NULL;
        if (b8g_jvm_cp_member(cls, idx, &cn, &fn, &fd) != 0) {
          set_err(vm->err, sizeof(vm->err), "bad putfield #%u", idx);
          status = -1;
          goto done;
        }
        int64_t val = 0;
        if (fd[0] == 'J' || fd[0] == 'D') {
          val = POP_I64();
        } else if (fd[0] == 'L' || fd[0] == '[') {
          val = (int64_t)(uintptr_t)POP_REF();
        } else {
          val = (int64_t)POP_I32();
        }
        void *objref = POP_REF();
        if (vm_putfield(vm, objref, idx, val) != 0) {
          status = -1;
          goto done;
        }
        break;
      }
      case 0xb6: { /* invokevirtual */
        uint16_t idx = read_u16(code, pc);
        pc += 2;
        const char *cn = NULL, *mn = NULL, *md = NULL;
        if (b8g_jvm_cp_member(cls, idx, &cn, &mn, &md) != 0) {
          set_err(vm->err, sizeof(vm->err), "bad invokevirtual #%u", idx);
          status = -1;
          goto done;
        }
        if (strcmp(cn, "java/io/PrintStream") == 0 &&
            (strcmp(mn, "println") == 0 || strcmp(mn, "print") == 0)) {
          int nl = (mn[5] == 'l');
          if (strcmp(md, "(I)V") == 0) {
            int32_t v = POP_I32();
            (void)POP_REF();
            printf("%" PRId32 "%s", v, nl ? "\n" : "");
          } else if (strcmp(md, "(J)V") == 0) {
            int64_t v = POP_I64();
            (void)POP_REF();
            printf("%" PRId64 "%s", v, nl ? "\n" : "");
          } else if (strcmp(md, "(Ljava/lang/String;)V") == 0) {
            const char *s = (const char *)POP_REF();
            (void)POP_REF();
            printf("%s%s", s ? s : "null", nl ? "\n" : "");
          } else if (strcmp(md, "()V") == 0) {
            (void)POP_REF();
            if (nl) printf("\n");
          } else {
            set_err(vm->err, sizeof(vm->err),
                    "unsupported PrintStream.%s descriptor %s", mn, md);
            status = -1;
            goto done;
          }
          fflush(stdout);
        } else {
          set_err(vm->err, sizeof(vm->err),
                  "unsupported invokevirtual %s.%s%s", cn, mn, md);
          status = -1;
          goto done;
        }
        break;
      }
      case 0xb7: { /* invokespecial */
        uint16_t idx = read_u16(code, pc);
        pc += 2;
        const char *cn = NULL, *mn = NULL, *md = NULL;
        if (b8g_jvm_cp_member(cls, idx, &cn, &mn, &md) != 0) {
          set_err(vm->err, sizeof(vm->err), "bad invokespecial #%u", idx);
          status = -1;
          goto done;
        }
        char c_arg_types[64];
        char c_ret = 'V';
        int c_argc = b8g_jvm_desc_arg_info(md, c_arg_types, 64, &c_ret);
        if (c_argc < 0 || c_argc > 63) {
          set_err(vm->err, sizeof(vm->err), "invalid descriptor %s", md);
          status = -1;
          goto done;
        }
        b8g_val_t call_args[64];
        for (int a = c_argc; a >= 1; a--) {
          call_args[a] = stack[--sp];
        }
        call_args[0] = stack[--sp]; /* receiver objref */
        if (strcmp(cn, "java/lang/Object") == 0 && strcmp(mn, "<init>") == 0) {
          break;
        }
        const b8g_method_t *target = b8g_jvm_find_method(cls, mn, md);
        if (target && target->has_code) {
          b8g_val_t call_ret;
          call_ret.i64 = 0;
          if (b8g_jvm_exec_method(vm, target, call_args, c_argc + 1,
                                  &call_ret) != 0) {
            status = -1;
            goto done;
          }
          if (c_ret != 'V') {
            stack[sp++] = call_ret;
          }
        } else if (strcmp(mn, "<init>") == 0) {
          /* External / default constructor no-op */
        } else {
          set_err(vm->err, sizeof(vm->err), "MethodNotFound: %s.%s%s", cn, mn, md);
          status = -1;
          goto done;
        }
        break;
      }
      case 0xb8: { /* invokestatic */
        uint16_t idx = read_u16(code, pc);
        pc += 2;
        const char *cn = NULL, *mn = NULL, *md = NULL;
        if (b8g_jvm_cp_member(cls, idx, &cn, &mn, &md) != 0) {
          set_err(vm->err, sizeof(vm->err), "bad invokestatic #%u", idx);
          status = -1;
          goto done;
        }
        if (strcmp(cn, "java/lang/System") == 0 &&
            strcmp(mn, "nanoTime") == 0 && strcmp(md, "()J") == 0) {
          PUSH_I64(b8g_jvm_nanotime());
          break;
        }
        if (strcmp(cn, "java/lang/System") == 0 &&
            strcmp(mn, "currentTimeMillis") == 0 && strcmp(md, "()J") == 0) {
          PUSH_I64(b8g_jvm_nanotime() / 1000000LL);
          break;
        }
        if (strcmp(cn, "kotlin/jvm/internal/Intrinsics") == 0) {
          if ((strcmp(mn, "checkNotNullParameter") == 0 ||
               strcmp(mn, "checkNotNullExpressionValue") == 0) &&
              strcmp(md, "(Ljava/lang/Object;Ljava/lang/String;)V") == 0) {
            (void)POP_REF();
            (void)POP_REF();
            break;
          }
          if (strcmp(mn, "checkNotNull") == 0 &&
              strcmp(md, "(Ljava/lang/Object;)V") == 0) {
            (void)POP_REF();
            break;
          }
          if (strcmp(mn, "areEqual") == 0 &&
              strcmp(md, "(Ljava/lang/Object;Ljava/lang/Object;)Z") == 0) {
            void *b = POP_REF();
            void *a = POP_REF();
            PUSH_I32(a == b ? 1 : 0);
            break;
          }
        }
        const b8g_method_t *target = b8g_jvm_find_method(cls, mn, md);
        if (!target) {
          set_err(vm->err, sizeof(vm->err), "MethodNotFound: %s.%s%s", cn, mn, md);
          status = -1;
          goto done;
        }
        char c_arg_types[64];
        char c_ret = 'V';
        int c_argc = b8g_jvm_desc_arg_info(md, c_arg_types, 64, &c_ret);
        if (c_argc < 0 || c_argc > 64) {
          set_err(vm->err, sizeof(vm->err), "invalid descriptor %s", md);
          status = -1;
          goto done;
        }
        b8g_val_t call_args[64];
        for (int a = c_argc - 1; a >= 0; a--) {
          call_args[a] = stack[--sp];
        }
        b8g_val_t call_ret;
        call_ret.i64 = 0;
        if (b8g_jvm_exec_method(vm, target, call_args, c_argc, &call_ret) != 0) {
          status = -1;
          goto done;
        }
        if (c_ret != 'V') {
          stack[sp++] = call_ret;
        }
        break;
      }
      case 0xbb: { /* new */
        uint16_t class_idx = read_u16(code, pc);
        pc += 2;
        uintptr_t handle = vm_alloc_object(vm, class_idx);
        if (!handle) {
          status = -1;
          goto done;
        }
        PUSH_REF((void *)handle);
        break;
      }

      /* ---- Arrays ---- */
      case 0xbc: { /* newarray */
        uint8_t atype = code[pc++];
        int32_t count = POP_I32();
        b8g_array_t *arr = vm_alloc_array(vm, atype, count);
        if (!arr) {
          status = -1;
          goto done;
        }
        PUSH_REF(arr);
        break;
      }
      case 0xbe: { /* arraylength */
        b8g_array_t *arr = (b8g_array_t *)POP_REF();
        if (!arr) {
          set_err(vm->err, sizeof(vm->err), "NullPointerException in arraylength");
          status = -1;
          goto done;
        }
        PUSH_I32(arr->length);
        break;
      }

      default:
        set_err(vm->err, sizeof(vm->err),
                "unsupported opcode 0x%02X at pc=%" PRIu32 " in %s",
                op, op_pc, m->name ? m->name : "<unknown>");
        status = -1;
        goto done;
    }
  }

done:
  vm->call_depth--;
  if (heap_locals) free(locals);
  if (heap_stack) free(stack);
  return status;
}

int b8g_jvm_run_main(b8g_jvm_vm_t *vm) {
  const b8g_method_t *m =
      b8g_jvm_find_method(vm->cls, "main", "([Ljava/lang/String;)V");
  if (!m) {
    m = b8g_jvm_find_method(vm->cls, "main", "()V");
  }
  if (!m) {
    set_err(vm->err, sizeof(vm->err), "no static main method found");
    return -1;
  }
  b8g_val_t arg0;
  arg0.i64 = 0;
  arg0.ref = NULL;
  int argc = (strcmp(m->desc, "()V") == 0) ? 0 : 1;
  return b8g_jvm_exec_method(vm, m, &arg0, argc, NULL);
}
