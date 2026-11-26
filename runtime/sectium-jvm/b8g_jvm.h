#ifndef B8G_JVM_H
#define B8G_JVM_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define B8G_JVM_VERSION_STR \
  "sectium-jvm v0.1.0 (C11 zero-JDK JVM bytecode interpreter + AOT, dup_jvm=0 B)"

/* Constant pool tags */
#define JVM_CP_UTF8         1
#define JVM_CP_INTEGER      3
#define JVM_CP_FLOAT        4
#define JVM_CP_LONG         5
#define JVM_CP_DOUBLE       6
#define JVM_CP_CLASS        7
#define JVM_CP_STRING       8
#define JVM_CP_FIELDREF     9
#define JVM_CP_METHODREF    10
#define JVM_CP_IFMETHODREF  11
#define JVM_CP_NAMEANDTYPE  12
#define JVM_CP_METHODHANDLE 15
#define JVM_CP_METHODTYPE   16
#define JVM_CP_DYNAMIC      17
#define JVM_CP_INVOKEDYN    18
#define JVM_CP_MODULE       19
#define JVM_CP_PACKAGE      20

/* Access flags */
#define JVM_ACC_STATIC      0x0008

/* newarray atypes */
#define JVM_T_BOOLEAN       4
#define JVM_T_CHAR          5
#define JVM_T_FLOAT         6
#define JVM_T_DOUBLE        7
#define JVM_T_BYTE          8
#define JVM_T_SHORT         9
#define JVM_T_INT           10
#define JVM_T_LONG          11

/* Sentinel pointer for java/lang/System.out */
#define JVM_SYSTEM_OUT_REF  ((void *)(uintptr_t)0x57D007u)

/* Bump-allocated object arena & static field table limits */
#define B8G_JVM_MAX_OBJECTS     4096
#define B8G_JVM_MAX_OBJ_FIELDS  16
#define B8G_JVM_MAX_STATICS     256

typedef struct {
  uint8_t tag;
  union {
    struct {
      char *str;
      uint16_t len;
    } utf8;
    int32_t i32;
    float f32;
    int64_t i64;
    double f64;
    uint16_t index1;
    struct {
      uint16_t class_index;
      uint16_t nat_index;
    } ref;
    struct {
      uint16_t name_index;
      uint16_t desc_index;
    } nat;
  } u;
} b8g_cp_entry_t;

typedef struct {
  uint16_t access_flags;
  uint16_t name_index;
  uint16_t desc_index;
  const char *name;
  const char *desc;
  int has_code;
  uint16_t max_stack;
  uint16_t max_locals;
  uint32_t code_len;
  uint8_t *code;
} b8g_method_t;

typedef struct {
  uint16_t minor_version;
  uint16_t major_version;
  uint16_t cp_count;
  b8g_cp_entry_t *cp;
  uint16_t access_flags;
  uint16_t this_class;
  uint16_t super_class;
  const char *this_name;
  uint16_t methods_count;
  b8g_method_t *methods;
} b8g_jvm_class_t;

typedef union {
  int32_t i32;
  int64_t i64;
  void *ref;
} b8g_val_t;

typedef struct b8g_array {
  uint8_t atype;
  int32_t length;
  void *data;
  struct b8g_array *next;
} b8g_array_t;

typedef struct {
  uint16_t class_idx;
  uint8_t field_count;
  uint16_t field_keys[B8G_JVM_MAX_OBJ_FIELDS];
  int64_t field_vals[B8G_JVM_MAX_OBJ_FIELDS];
} b8g_jvm_obj_t;

typedef struct {
  uint16_t key;
  int64_t val;
} b8g_jvm_static_t;

typedef struct {
  const b8g_jvm_class_t *cls;
  b8g_array_t *heap_head;
  b8g_jvm_obj_t *objects;
  uint32_t obj_count;
  b8g_jvm_static_t statics[B8G_JVM_MAX_STATICS];
  uint16_t static_count;
  int call_depth;
  int max_call_depth;
  char err[256];
} b8g_jvm_vm_t;

/* Parser & metadata helpers */
int b8g_jvm_parse_class(const uint8_t *data, size_t len,
                        b8g_jvm_class_t *out, char *err, size_t err_cap);
void b8g_jvm_free_class(b8g_jvm_class_t *cls);
const char *b8g_jvm_cp_utf8(const b8g_jvm_class_t *cls, uint16_t idx);
const char *b8g_jvm_cp_class_name(const b8g_jvm_class_t *cls, uint16_t class_idx);
int b8g_jvm_cp_member(const b8g_jvm_class_t *cls, uint16_t ref_idx,
                      const char **out_cls, const char **out_name,
                      const char **out_desc);
const b8g_method_t *b8g_jvm_find_method(const b8g_jvm_class_t *cls,
                                        const char *name, const char *desc);

/*
 * Parse JVM method descriptor "(args)ret".
 * Each arg type stored as 'I', 'J', 'L' (ref/array), 'F', 'D'.
 * Returns number of arguments, or -1 on error.
 */
int b8g_jvm_desc_arg_info(const char *desc, char *arg_types, int max_args,
                          char *ret_type);

/* Tier-0 Interpreter */
void b8g_jvm_vm_init(b8g_jvm_vm_t *vm, const b8g_jvm_class_t *cls);
void b8g_jvm_vm_free(b8g_jvm_vm_t *vm);
int b8g_jvm_exec_method(b8g_jvm_vm_t *vm, const b8g_method_t *m,
                        const b8g_val_t *args, int arg_count,
                        b8g_val_t *ret_val);
int b8g_jvm_run_main(b8g_jvm_vm_t *vm);
int64_t b8g_jvm_nanotime(void);

/* Tier-2 AOT C11 Transpiler */
int b8g_jvm_emit_c(const b8g_jvm_class_t *cls, FILE *out,
                   char *err, size_t err_cap);

#endif /* B8G_JVM_H */
