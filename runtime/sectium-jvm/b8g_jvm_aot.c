#define _POSIX_C_SOURCE 200809L

#include "b8g_jvm.h"

#include <ctype.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

static void aot_err(char *buf, size_t cap, const char *fmt, ...) {
  if (!buf || cap == 0) return;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, cap, fmt, ap);
  va_end(ap);
}

static inline int16_t aot_s16(const uint8_t *code, uint32_t pc) {
  return (int16_t)(((uint16_t)code[pc] << 8) | code[pc + 1]);
}

static inline uint16_t aot_u16(const uint8_t *code, uint32_t pc) {
  return (uint16_t)(((uint16_t)code[pc] << 8) | code[pc + 1]);
}

static void emit_c_string(FILE *out, const char *s) {
  fputc('"', out);
  for (; s && *s; s++) {
    unsigned char c = (unsigned char)*s;
    switch (c) {
      case '\\': fputs("\\\\", out); break;
      case '"':  fputs("\\\"", out); break;
      case '\n': fputs("\\n", out); break;
      case '\r': fputs("\\r", out); break;
      case '\t': fputs("\\t", out); break;
      default:
        if (c < 0x20 || c >= 0x7f) {
          fprintf(out, "\\x%02x", c);
        } else {
          fputc((int)c, out);
        }
        break;
    }
  }
  fputc('"', out);
}

static void sanitize_method_name(const b8g_jvm_class_t *cls, uint16_t idx,
                                 char *buf, size_t cap) {
  const b8g_method_t *m = &cls->methods[idx];
  const char *name = m->name ? m->name : "fn";
  /* Check if overloaded */
  int dup = 0;
  for (uint16_t i = 0; i < cls->methods_count; i++) {
    if (i != idx && cls->methods[i].name &&
        strcmp(cls->methods[i].name, name) == 0) {
      dup = 1;
      break;
    }
  }
  size_t pos = 0;
  const char *prefix = "jvm_";
  while (*prefix && pos + 1 < cap) buf[pos++] = *prefix++;
  for (const char *p = name; *p && pos + 1 < cap; p++) {
    buf[pos++] = (isalnum((unsigned char)*p) || *p == '_') ? *p : '_';
  }
  if (dup && pos + 8 < cap) {
    pos += (size_t)snprintf(buf + pos, cap - pos, "_%u", idx);
  }
  buf[pos] = '\0';
}

static const char *c_type_for_desc(char t) {
  switch (t) {
    case 'I': return "int32_t";
    case 'J': return "int64_t";
    case 'L': return "int64_t";
    case 'V': return "void";
    default:  return "int32_t";
  }
}

/* Compute instruction length and stack delta (pops, pushes) */
static int insn_info(const b8g_jvm_class_t *cls, const uint8_t *code,
                     uint32_t pc, uint32_t *out_len, int *out_pop,
                     int *out_push, int *out_wide_stack, int *out_is_term,
                     int *out_has_branch, uint32_t *out_target) {
  uint8_t op = code[pc];
  uint32_t len = 1;
  int pops = 0, pushes = 0;
  int wide = 0, term = 0, has_br = 0;
  uint32_t target = 0;

  switch (op) {
    case 0x00: break; /* nop */
    case 0x01: pushes = 1; wide = 1; break; /* aconst_null */
    case 0x02: case 0x03: case 0x04: case 0x05:
    case 0x06: case 0x07: case 0x08: pushes = 1; break;
    case 0x09: case 0x0a: pushes = 1; wide = 1; break;
    case 0x10: len = 2; pushes = 1; break; /* bipush */
    case 0x11: len = 3; pushes = 1; break; /* sipush */
    case 0x12: /* ldc */
    case 0x13: /* ldc_w */ {
      uint16_t idx = (op == 0x12) ? code[pc + 1] : aot_u16(code, pc + 1);
      len = (op == 0x12) ? 2 : 3;
      pushes = 1;
      if (idx > 0 && idx < cls->cp_count && cls->cp[idx].tag == JVM_CP_STRING) {
        wide = 1;
      }
      break;
    }
    case 0x14: len = 3; pushes = 1; wide = 1; break; /* ldc2_w */
    case 0x15: len = 2; pushes = 1; break; /* iload */
    case 0x16: len = 2; pushes = 1; wide = 1; break; /* lload */
    case 0x19: len = 2; pushes = 1; wide = 1; break; /* aload */
    case 0x1a: case 0x1b: case 0x1c: case 0x1d: pushes = 1; break;
    case 0x1e: case 0x1f: case 0x20: case 0x21: pushes = 1; wide = 1; break;
    case 0x2a: case 0x2b: case 0x2c: case 0x2d: pushes = 1; wide = 1; break;
    case 0x2e: case 0x33: pops = 2; pushes = 1; wide = 1; break; /* iaload/baload */
    case 0x36: len = 2; pops = 1; break; /* istore */
    case 0x37: len = 2; pops = 1; wide = 1; break; /* lstore */
    case 0x3a: len = 2; pops = 1; wide = 1; break; /* astore */
    case 0x3b: case 0x3c: case 0x3d: case 0x3e: pops = 1; break;
    case 0x3f: case 0x40: case 0x41: case 0x42: pops = 1; wide = 1; break;
    case 0x4b: case 0x4c: case 0x4d: case 0x4e: pops = 1; wide = 1; break;
    case 0x4f: case 0x54: pops = 3; wide = 1; break; /* iastore/bastore */
    case 0x57: pops = 1; break; /* pop */
    case 0x58: pops = 2; break; /* pop2 */
    case 0x59: pops = 1; pushes = 2; break; /* dup */
    case 0x5f: pops = 2; pushes = 2; break; /* swap */
    case 0x60: case 0x64: case 0x68: case 0x6c: case 0x70:
    case 0x78: case 0x7a: case 0x7c: case 0x7e: case 0x80: case 0x82:
      pops = 2; pushes = 1; break;
    case 0x61: case 0x65: case 0x69: case 0x6d: case 0x71: case 0x94:
      pops = 2; pushes = 1; wide = 1; break;
    case 0x74: case 0x91: case 0x92: case 0x93:
      pops = 1; pushes = 1; break;
    case 0x75: case 0x85: case 0x88:
      pops = 1; pushes = 1; wide = 1; break;
    case 0x84: len = 3; break; /* iinc */
    case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: case 0x9e:
    case 0xc6: case 0xc7:
      len = 3; pops = 1; has_br = 1;
      target = (uint32_t)((int32_t)pc + aot_s16(code, pc + 1));
      break;
    case 0x9f: case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4:
      len = 3; pops = 2; has_br = 1;
      target = (uint32_t)((int32_t)pc + aot_s16(code, pc + 1));
      break;
    case 0xa7:
      len = 3; has_br = 1; term = 1;
      target = (uint32_t)((int32_t)pc + aot_s16(code, pc + 1));
      break;
    case 0xac: case 0xad: case 0xb0:
      pops = 1; term = 1;
      if (op != 0xac) wide = 1;
      break;
    case 0xb1:
      term = 1;
      break;
    case 0xb2: /* getstatic */
      len = 3; pushes = 1; wide = 1;
      break;
    case 0xb3: /* putstatic */
      len = 3; pops = 1; wide = 1;
      break;
    case 0xb4: /* getfield */
      len = 3; pops = 1; pushes = 1; wide = 1;
      break;
    case 0xb5: /* putfield */
      len = 3; pops = 2; wide = 1;
      break;
    case 0xb6: /* invokevirtual */
    case 0xb7: /* invokespecial */ {
      len = 3; wide = 1;
      uint16_t idx = aot_u16(code, pc + 1);
      const char *cn = NULL, *mn = NULL, *md = NULL;
      if (b8g_jvm_cp_member(cls, idx, &cn, &mn, &md) != 0) return -1;
      char at[64], rt = 'V';
      int argc = b8g_jvm_desc_arg_info(md, at, 64, &rt);
      if (argc < 0) return -1;
      pops = argc + 1; /* args + receiver */
      pushes = (rt == 'V') ? 0 : 1;
      break;
    }
    case 0xb8: /* invokestatic */ {
      len = 3;
      uint16_t idx = aot_u16(code, pc + 1);
      const char *cn = NULL, *mn = NULL, *md = NULL;
      if (b8g_jvm_cp_member(cls, idx, &cn, &mn, &md) != 0) return -1;
      char at[64], rt = 'V';
      int argc = b8g_jvm_desc_arg_info(md, at, 64, &rt);
      if (argc < 0) return -1;
      pops = argc;
      pushes = (rt == 'V') ? 0 : 1;
      if (rt == 'J' || rt == 'L') wide = 1;
      for (int i = 0; i < argc; i++) {
        if (at[i] == 'J' || at[i] == 'L') wide = 1;
      }
      break;
    }
    case 0xbb: /* new */
      len = 3; pushes = 1; wide = 1;
      break;
    case 0xbc: /* newarray */
      len = 2; pops = 1; pushes = 1; wide = 1;
      break;
    case 0xbe: /* arraylength */
      pops = 1; pushes = 1; wide = 1;
      break;
    default:
      return -1;
  }

  *out_len = len;
  *out_pop = pops;
  *out_push = pushes;
  *out_wide_stack = wide;
  *out_is_term = term;
  *out_has_branch = has_br;
  *out_target = target;
  return 0;
}

static int find_method_index(const b8g_jvm_class_t *cls, const char *name,
                             const char *desc) {
  for (uint16_t i = 0; i < cls->methods_count; i++) {
    if (cls->methods[i].name && cls->methods[i].desc &&
        strcmp(cls->methods[i].name, name) == 0 &&
        strcmp(cls->methods[i].desc, desc) == 0) {
      return (int)i;
    }
  }
  return -1;
}

static int emit_method_sig(const b8g_jvm_class_t *cls, uint16_t midx,
                           FILE *out, int is_decl) {
  const b8g_method_t *m = &cls->methods[midx];
  char arg_types[64];
  char ret_type = 'V';
  int argc = b8g_jvm_desc_arg_info(m->desc, arg_types, 64, &ret_type);
  if (argc < 0) return -1;

  int is_static = (m->access_flags & JVM_ACC_STATIC) != 0;
  char cname[128];
  sanitize_method_name(cls, midx, cname, sizeof(cname));
  fprintf(out, "static %s %s(", c_type_for_desc(ret_type), cname);
  if (is_static && argc == 0) {
    fputs("void", out);
  } else {
    int slot = 0;
    int emitted = 0;
    if (!is_static) {
      fputs("int64_t l0", out);
      slot = 1;
      emitted = 1;
    }
    for (int i = 0; i < argc; i++) {
      if (emitted > 0) fputs(", ", out);
      fprintf(out, "%s l%d", c_type_for_desc(arg_types[i]), slot);
      slot += (arg_types[i] == 'J' || arg_types[i] == 'D') ? 2 : 1;
      emitted++;
    }
  }
  fprintf(out, ")%s\n", is_decl ? ";" : " {");
  return 0;
}

static int emit_method_body(const b8g_jvm_class_t *cls, uint16_t midx,
                            FILE *out, char *err, size_t err_cap) {
  const b8g_method_t *m = &cls->methods[midx];
  uint32_t clen = m->code_len;
  const uint8_t *code = m->code;

  int *depth = (int *)malloc((clen + 1) * sizeof(int));
  uint8_t *is_target = (uint8_t *)calloc(clen + 1, 1);
  uint32_t *worklist = (uint32_t *)malloc((clen + 1) * sizeof(uint32_t));
  if (!depth || !is_target || !worklist) {
    free(depth);
    free(is_target);
    free(worklist);
    aot_err(err, err_cap, "out of memory in AOT analysis");
    return -1;
  }
  for (uint32_t i = 0; i <= clen; i++) depth[i] = -1;

  /* Track local types: 'I' default, 'J' for long/ref */
  uint16_t nlocals = m->max_locals < 1 ? 1 : m->max_locals;
  char *local_types = (char *)malloc(nlocals);
  if (!local_types) {
    free(depth);
    free(is_target);
    free(worklist);
    aot_err(err, err_cap, "out of memory for local types");
    return -1;
  }
  memset(local_types, 'I', nlocals);

  char arg_types[64];
  char ret_type = 'V';
  int argc = b8g_jvm_desc_arg_info(m->desc, arg_types, 64, &ret_type);
  int is_static = (m->access_flags & JVM_ACC_STATIC) != 0;
  int param_slots = 0;
  if (!is_static) {
    local_types[0] = 'J';
    param_slots = 1;
  }
  for (int i = 0; i < argc; i++) {
    if (param_slots < (int)nlocals) {
      local_types[param_slots] = (arg_types[i] == 'I') ? 'I' : 'J';
    }
    param_slots += (arg_types[i] == 'J' || arg_types[i] == 'D') ? 2 : 1;
  }

  /* Worklist pass: compute stack depths, branch targets, wide usage, local types */
  int wl_head = 0, wl_tail = 0;
  int max_depth = 0;
  int use_wide_stack = 0;
  depth[0] = 0;
  worklist[wl_tail++] = 0;

  while (wl_head < wl_tail) {
    uint32_t pc = worklist[wl_head++];
    if (pc >= clen) continue;
    int d = depth[pc];
    uint32_t ilen = 0, target = 0;
    int pops = 0, pushes = 0, wide = 0, term = 0, has_br = 0;
    if (insn_info(cls, code, pc, &ilen, &pops, &pushes, &wide, &term, &has_br,
                  &target) != 0) {
      aot_err(err, err_cap, "AOT unsupported opcode 0x%02X at pc=%" PRIu32,
              code[pc], pc);
      free(local_types);
      free(depth);
      free(is_target);
      free(worklist);
      return -1;
    }
    if (wide) use_wide_stack = 1;

    /* Detect 64-bit / ref locals */
    uint8_t op = code[pc];
    if (op == 0x16 || op == 0x19 || op == 0x37 || op == 0x3a) {
      uint8_t lidx = code[pc + 1];
      if (lidx < nlocals) local_types[lidx] = 'J';
    } else if (op >= 0x1e && op <= 0x21) {
      if ((op - 0x1e) < nlocals) local_types[op - 0x1e] = 'J';
    } else if (op >= 0x2a && op <= 0x2d) {
      if ((op - 0x2a) < nlocals) local_types[op - 0x2a] = 'J';
    } else if (op >= 0x3f && op <= 0x42) {
      if ((op - 0x3f) < nlocals) local_types[op - 0x3f] = 'J';
    } else if (op >= 0x4b && op <= 0x4e) {
      if ((op - 0x4b) < nlocals) local_types[op - 0x4b] = 'J';
    }

    int nd = d - pops + pushes;
    if (nd < 0) nd = 0;
    if (nd > max_depth) max_depth = nd;
    if (d > max_depth) max_depth = d;

    if (has_br && target < clen) {
      is_target[target] = 1;
      if (depth[target] < 0) {
        depth[target] = nd;
        worklist[wl_tail++] = target;
      }
    }
    if (!term && pc + ilen < clen) {
      if (depth[pc + ilen] < 0) {
        depth[pc + ilen] = nd;
        worklist[wl_tail++] = pc + ilen;
      }
    }
  }

  /* Emit signature */
  emit_method_sig(cls, midx, out, 0);

  /* Silence unused parameter warnings for main(args) / <init>(this) etc. */
  {
    int slot = 0;
    if (!is_static) {
      fputs("  (void)l0;\n", out);
      slot = 1;
    }
    for (int i = 0; i < argc; i++) {
      fprintf(out, "  (void)l%d;\n", slot);
      slot += (arg_types[i] == 'J' || arg_types[i] == 'D') ? 2 : 1;
    }
  }

  /* Declare non-parameter locals */
  for (int i = param_slots; i < (int)nlocals; i++) {
    fprintf(out, "  %s l%d = 0; (void)l%d;\n",
            local_types[i] == 'J' ? "int64_t" : "int32_t", i, i);
  }

  /* Declare operand stack slots s0..sN */
  const char *st_type = use_wide_stack ? "int64_t" : "int32_t";
  int nslots = max_depth > (int)m->max_stack ? max_depth : (int)m->max_stack;
  if (nslots > 0) {
    fprintf(out, "  %s ", st_type);
    for (int i = 0; i < nslots; i++) {
      fprintf(out, "%ss%d = 0", i > 0 ? ", " : "", i);
    }
    fputs(";\n", out);
    for (int i = 0; i < nslots; i++) {
      fprintf(out, "  (void)s%d;\n", i);
    }
  }

  /* Emit instructions linearly */
  uint32_t pc = 0;
  while (pc < clen) {
    if (depth[pc] < 0) {
      pc++;
      continue;
    }
    if (is_target[pc]) {
      fprintf(out, "L_%" PRIu32 ":\n", pc);
    }

    int d = depth[pc];
    uint32_t ilen = 0, target = 0;
    int pops = 0, pushes = 0, wide = 0, term = 0, has_br = 0;
    insn_info(cls, code, pc, &ilen, &pops, &pushes, &wide, &term, &has_br,
              &target);
    uint8_t op = code[pc];

    switch (op) {
      case 0x00: /* nop */
        break;
      case 0x01: /* aconst_null */
        fprintf(out, "  s%d = 0;\n", d);
        break;
      case 0x02: case 0x03: case 0x04: case 0x05:
      case 0x06: case 0x07: case 0x08:
        fprintf(out, "  s%d = %d;\n", d, (int)op - 3);
        break;
      case 0x09: fprintf(out, "  s%d = 0LL;\n", d); break;
      case 0x0a: fprintf(out, "  s%d = 1LL;\n", d); break;
      case 0x10:
        fprintf(out, "  s%d = %d;\n", d, (int)(int8_t)code[pc + 1]);
        break;
      case 0x11:
        fprintf(out, "  s%d = %d;\n", d, (int)aot_s16(code, pc + 1));
        break;
      case 0x12:
      case 0x13: {
        uint16_t idx = (op == 0x12) ? code[pc + 1] : aot_u16(code, pc + 1);
        b8g_cp_entry_t *e = &cls->cp[idx];
        if (e->tag == JVM_CP_INTEGER) {
          fprintf(out, "  s%d = (int32_t)%" PRId32 ";\n", d, e->u.i32);
        } else if (e->tag == JVM_CP_STRING) {
          const char *s = b8g_jvm_cp_utf8(cls, e->u.index1);
          fprintf(out, "  s%d = (int64_t)(intptr_t)", d);
          emit_c_string(out, s ? s : "");
          fputs(";\n", out);
        }
        break;
      }
      case 0x14: {
        uint16_t idx = aot_u16(code, pc + 1);
        fprintf(out, "  s%d = %" PRId64 "LL;\n", d, cls->cp[idx].u.i64);
        break;
      }

      /* Loads */
      case 0x15: case 0x16: case 0x19:
        fprintf(out, "  s%d = l%u;\n", d, code[pc + 1]);
        break;
      case 0x1a: case 0x1b: case 0x1c: case 0x1d:
        fprintf(out, "  s%d = l%d;\n", d, op - 0x1a);
        break;
      case 0x1e: case 0x1f: case 0x20: case 0x21:
        fprintf(out, "  s%d = l%d;\n", d, op - 0x1e);
        break;
      case 0x2a: case 0x2b: case 0x2c: case 0x2d:
        fprintf(out, "  s%d = l%d;\n", d, op - 0x2a);
        break;

      /* Array loads */
      case 0x2e: /* iaload */
        fprintf(out, "  s%d = ((b8g_arr_t *)(intptr_t)s%d)->i32[(int32_t)s%d];\n",
                d - 2, d - 2, d - 1);
        break;
      case 0x33: /* baload */
        fprintf(out, "  s%d = (int32_t)((b8g_arr_t *)(intptr_t)s%d)->i8[(int32_t)s%d];\n",
                d - 2, d - 2, d - 1);
        break;

      /* Stores */
      case 0x36: case 0x37: case 0x3a:
        fprintf(out, "  l%u = %ss%d;\n", code[pc + 1],
                (op == 0x36) ? "(int32_t)" : "", d - 1);
        break;
      case 0x3b: case 0x3c: case 0x3d: case 0x3e:
        fprintf(out, "  l%d = (int32_t)s%d;\n", op - 0x3b, d - 1);
        break;
      case 0x3f: case 0x40: case 0x41: case 0x42:
        fprintf(out, "  l%d = s%d;\n", op - 0x3f, d - 1);
        break;
      case 0x4b: case 0x4c: case 0x4d: case 0x4e:
        fprintf(out, "  l%d = s%d;\n", op - 0x4b, d - 1);
        break;

      /* Array stores */
      case 0x4f: /* iastore */
        fprintf(out, "  ((b8g_arr_t *)(intptr_t)s%d)->i32[(int32_t)s%d] = (int32_t)s%d;\n",
                d - 3, d - 2, d - 1);
        break;
      case 0x54: /* bastore */
        fprintf(out, "  ((b8g_arr_t *)(intptr_t)s%d)->i8[(int32_t)s%d] = (int8_t)s%d;\n",
                d - 3, d - 2, d - 1);
        break;

      /* Stack */
      case 0x57: case 0x58: break; /* pop / pop2 */
      case 0x59: /* dup */
        fprintf(out, "  s%d = s%d;\n", d, d - 1);
        break;
      case 0x5f: /* swap */
        fprintf(out, "  { %s _t = s%d; s%d = s%d; s%d = _t; }\n",
                st_type, d - 1, d - 1, d - 2, d - 2);
        break;

      /* Int / Long arithmetic */
      case 0x60: fprintf(out, "  s%d = (int32_t)((uint32_t)(int32_t)s%d + (uint32_t)(int32_t)s%d);\n", d - 2, d - 2, d - 1); break;
      case 0x61: fprintf(out, "  s%d = (int64_t)((uint64_t)s%d + (uint64_t)s%d);\n", d - 2, d - 2, d - 1); break;
      case 0x64: fprintf(out, "  s%d = (int32_t)((uint32_t)(int32_t)s%d - (uint32_t)(int32_t)s%d);\n", d - 2, d - 2, d - 1); break;
      case 0x65: fprintf(out, "  s%d = (int64_t)((uint64_t)s%d - (uint64_t)s%d);\n", d - 2, d - 2, d - 1); break;
      case 0x68: fprintf(out, "  s%d = (int32_t)((uint32_t)(int32_t)s%d * (uint32_t)(int32_t)s%d);\n", d - 2, d - 2, d - 1); break;
      case 0x69: fprintf(out, "  s%d = (int64_t)((uint64_t)s%d * (uint64_t)s%d);\n", d - 2, d - 2, d - 1); break;
      case 0x6c: fprintf(out, "  s%d = (int32_t)s%d / (int32_t)s%d;\n", d - 2, d - 2, d - 1); break;
      case 0x6d: fprintf(out, "  s%d = (int64_t)s%d / (int64_t)s%d;\n", d - 2, d - 2, d - 1); break;
      case 0x70: fprintf(out, "  s%d = (int32_t)s%d %% (int32_t)s%d;\n", d - 2, d - 2, d - 1); break;
      case 0x71: fprintf(out, "  s%d = (int64_t)s%d %% (int64_t)s%d;\n", d - 2, d - 2, d - 1); break;
      case 0x74: fprintf(out, "  s%d = (int32_t)(-(uint32_t)(int32_t)s%d);\n", d - 1, d - 1); break;
      case 0x75: fprintf(out, "  s%d = (int64_t)(-(uint64_t)s%d);\n", d - 1, d - 1); break;
      case 0x78: fprintf(out, "  s%d = (int32_t)((uint32_t)(int32_t)s%d << ((int32_t)s%d & 31));\n", d - 2, d - 2, d - 1); break;
      case 0x7a: fprintf(out, "  s%d = (int32_t)s%d >> ((int32_t)s%d & 31);\n", d - 2, d - 2, d - 1); break;
      case 0x7c: fprintf(out, "  s%d = (int32_t)((uint32_t)(int32_t)s%d >> ((int32_t)s%d & 31));\n", d - 2, d - 2, d - 1); break;
      case 0x7e: fprintf(out, "  s%d = (int32_t)s%d & (int32_t)s%d;\n", d - 2, d - 2, d - 1); break;
      case 0x80: fprintf(out, "  s%d = (int32_t)s%d | (int32_t)s%d;\n", d - 2, d - 2, d - 1); break;
      case 0x82: fprintf(out, "  s%d = (int32_t)s%d ^ (int32_t)s%d;\n", d - 2, d - 2, d - 1); break;
      case 0x84:
        fprintf(out, "  l%u = (int32_t)((uint32_t)l%u + (uint32_t)(int32_t)(%d));\n",
                code[pc + 1], code[pc + 1], (int)(int8_t)code[pc + 2]);
        break;
      case 0x85: fprintf(out, "  s%d = (int64_t)(int32_t)s%d;\n", d - 1, d - 1); break;
      case 0x88: fprintf(out, "  s%d = (int32_t)s%d;\n", d - 1, d - 1); break;
      case 0x91: fprintf(out, "  s%d = (int32_t)(int8_t)s%d;\n", d - 1, d - 1); break;
      case 0x92: fprintf(out, "  s%d = (int32_t)(uint16_t)s%d;\n", d - 1, d - 1); break;
      case 0x93: fprintf(out, "  s%d = (int32_t)(int16_t)s%d;\n", d - 1, d - 1); break;
      case 0x94: fprintf(out, "  s%d = (s%d > s%d) ? 1 : ((s%d < s%d) ? -1 : 0);\n", d - 2, d - 2, d - 1, d - 2, d - 1); break;

      /* Branches */
      case 0x99: fprintf(out, "  if ((int32_t)s%d == 0) goto L_%" PRIu32 ";\n", d - 1, target); break;
      case 0x9a: fprintf(out, "  if ((int32_t)s%d != 0) goto L_%" PRIu32 ";\n", d - 1, target); break;
      case 0x9b: fprintf(out, "  if ((int32_t)s%d < 0) goto L_%" PRIu32 ";\n", d - 1, target); break;
      case 0x9c: fprintf(out, "  if ((int32_t)s%d >= 0) goto L_%" PRIu32 ";\n", d - 1, target); break;
      case 0x9d: fprintf(out, "  if ((int32_t)s%d > 0) goto L_%" PRIu32 ";\n", d - 1, target); break;
      case 0x9e: fprintf(out, "  if ((int32_t)s%d <= 0) goto L_%" PRIu32 ";\n", d - 1, target); break;
      case 0x9f: fprintf(out, "  if ((int32_t)s%d == (int32_t)s%d) goto L_%" PRIu32 ";\n", d - 2, d - 1, target); break;
      case 0xa0: fprintf(out, "  if ((int32_t)s%d != (int32_t)s%d) goto L_%" PRIu32 ";\n", d - 2, d - 1, target); break;
      case 0xa1: fprintf(out, "  if ((int32_t)s%d < (int32_t)s%d) goto L_%" PRIu32 ";\n", d - 2, d - 1, target); break;
      case 0xa2: fprintf(out, "  if ((int32_t)s%d >= (int32_t)s%d) goto L_%" PRIu32 ";\n", d - 2, d - 1, target); break;
      case 0xa3: fprintf(out, "  if ((int32_t)s%d > (int32_t)s%d) goto L_%" PRIu32 ";\n", d - 2, d - 1, target); break;
      case 0xa4: fprintf(out, "  if ((int32_t)s%d <= (int32_t)s%d) goto L_%" PRIu32 ";\n", d - 2, d - 1, target); break;
      case 0xa7: fprintf(out, "  goto L_%" PRIu32 ";\n", target); break;
      case 0xc6: fprintf(out, "  if (s%d == 0) goto L_%" PRIu32 ";\n", d - 1, target); break;
      case 0xc7: fprintf(out, "  if (s%d != 0) goto L_%" PRIu32 ";\n", d - 1, target); break;

      /* Returns */
      case 0xac: fprintf(out, "  return (int32_t)s%d;\n", d - 1); break;
      case 0xad: fprintf(out, "  return (int64_t)s%d;\n", d - 1); break;
      case 0xb0: fprintf(out, "  return (int64_t)s%d;\n", d - 1); break;
      case 0xb1: fputs("  return;\n", out); break;

      /* Calls & Fields */
      case 0xb2: { /* getstatic */
        uint16_t idx = aot_u16(code, pc + 1);
        const char *cn = NULL, *fn = NULL, *fd = NULL;
        if (b8g_jvm_cp_member(cls, idx, &cn, &fn, &fd) == 0 &&
            strcmp(cn, "java/lang/System") == 0 && strcmp(fn, "out") == 0) {
          fprintf(out, "  s%d = 0;\n", d);
        } else {
          fprintf(out, "  s%d = b8g_getstatic(%u);\n", d, idx);
        }
        break;
      }
      case 0xb3: { /* putstatic */
        uint16_t idx = aot_u16(code, pc + 1);
        fprintf(out, "  b8g_putstatic(%u, (int64_t)s%d);\n", idx, d - 1);
        break;
      }
      case 0xb4: { /* getfield */
        uint16_t idx = aot_u16(code, pc + 1);
        fprintf(out, "  s%d = b8g_getfield(s%d, %u);\n", d - 1, d - 1, idx);
        break;
      }
      case 0xb5: { /* putfield */
        uint16_t idx = aot_u16(code, pc + 1);
        fprintf(out, "  b8g_putfield(s%d, %u, (int64_t)s%d);\n", d - 2, idx, d - 1);
        break;
      }
      case 0xb6: { /* invokevirtual */
        uint16_t idx = aot_u16(code, pc + 1);
        const char *cn = NULL, *mn = NULL, *md = NULL;
        b8g_jvm_cp_member(cls, idx, &cn, &mn, &md);
        if (strcmp(cn, "java/io/PrintStream") == 0 &&
            (strcmp(mn, "println") == 0 || strcmp(mn, "print") == 0)) {
          int nl = (mn[5] == 'l');
          if (strcmp(md, "(I)V") == 0) {
            fprintf(out, "  printf(\"%%\" PRId32 \"%s\", (int32_t)s%d);\n",
                    nl ? "\\n" : "", d - 1);
          } else if (strcmp(md, "(J)V") == 0) {
            fprintf(out, "  printf(\"%%\" PRId64 \"%s\", (int64_t)s%d);\n",
                    nl ? "\\n" : "", d - 1);
          } else if (strcmp(md, "(Ljava/lang/String;)V") == 0) {
            fprintf(out, "  printf(\"%%s%s\", s%d ? (const char *)(intptr_t)s%d : \"null\");\n",
                    nl ? "\\n" : "", d - 1, d - 1);
          } else if (strcmp(md, "()V") == 0 && nl) {
            fputs("  printf(\"\\n\");\n", out);
          }
        }
        break;
      }
      case 0xb7: { /* invokespecial */
        uint16_t idx = aot_u16(code, pc + 1);
        const char *cn = NULL, *mn = NULL, *md = NULL;
        b8g_jvm_cp_member(cls, idx, &cn, &mn, &md);
        if (strcmp(cn, "java/lang/Object") == 0 && strcmp(mn, "<init>") == 0) {
          break;
        }
        int tidx = find_method_index(cls, mn, md);
        if (tidx >= 0 && cls->methods[tidx].has_code) {
          char c_at[64], c_rt = 'V';
          int c_argc = b8g_jvm_desc_arg_info(md, c_at, 64, &c_rt);
          char cname[128];
          sanitize_method_name(cls, (uint16_t)tidx, cname, sizeof(cname));
          int base = d - (c_argc + 1);
          if (c_rt == 'V') {
            fprintf(out, "  %s((int64_t)s%d", cname, base);
          } else {
            fprintf(out, "  s%d = %s((int64_t)s%d", base, cname, base);
          }
          for (int a = 0; a < c_argc; a++) {
            fprintf(out, ", (%s)s%d", c_type_for_desc(c_at[a]), base + 1 + a);
          }
          fputs(");\n", out);
        } else if (strcmp(mn, "<init>") == 0) {
          /* External / default constructor no-op */
        } else {
          aot_err(err, err_cap, "AOT unresolved invokespecial %s.%s%s", cn, mn, md);
          free(local_types);
          free(depth);
          free(is_target);
          free(worklist);
          return -1;
        }
        break;
      }
      case 0xb8: { /* invokestatic */
        uint16_t idx = aot_u16(code, pc + 1);
        const char *cn = NULL, *mn = NULL, *md = NULL;
        b8g_jvm_cp_member(cls, idx, &cn, &mn, &md);
        if (strcmp(cn, "java/lang/System") == 0 &&
            strcmp(mn, "nanoTime") == 0) {
          fprintf(out, "  s%d = b8g_aot_nanotime();\n", d);
        } else if (strcmp(cn, "java/lang/System") == 0 &&
                   strcmp(mn, "currentTimeMillis") == 0) {
          fprintf(out, "  s%d = b8g_aot_nanotime() / 1000000LL;\n", d);
        } else if (strcmp(cn, "kotlin/jvm/internal/Intrinsics") == 0) {
          if ((strcmp(mn, "checkNotNullParameter") == 0 ||
               strcmp(mn, "checkNotNullExpressionValue") == 0) &&
              strcmp(md, "(Ljava/lang/Object;Ljava/lang/String;)V") == 0) {
            fprintf(out, "  (void)s%d; (void)s%d;\n", d - 2, d - 1);
          } else if (strcmp(mn, "checkNotNull") == 0 &&
                     strcmp(md, "(Ljava/lang/Object;)V") == 0) {
            fprintf(out, "  (void)s%d;\n", d - 1);
          } else if (strcmp(mn, "areEqual") == 0 &&
                     strcmp(md, "(Ljava/lang/Object;Ljava/lang/Object;)Z") == 0) {
            fprintf(out, "  s%d = (s%d == s%d) ? 1 : 0;\n", d - 2, d - 2, d - 1);
          }
        } else {
          int tidx = find_method_index(cls, mn, md);
          if (tidx < 0) {
            aot_err(err, err_cap, "AOT unresolved invokestatic %s.%s%s", cn, mn, md);
            free(local_types);
            free(depth);
            free(is_target);
            free(worklist);
            return -1;
          }
          char c_at[64], c_rt = 'V';
          int c_argc = b8g_jvm_desc_arg_info(md, c_at, 64, &c_rt);
          char cname[128];
          sanitize_method_name(cls, (uint16_t)tidx, cname, sizeof(cname));
          int base = d - c_argc;
          if (c_rt == 'V') {
            fprintf(out, "  %s(", cname);
          } else {
            fprintf(out, "  s%d = %s(", base, cname);
          }
          for (int a = 0; a < c_argc; a++) {
            if (a > 0) fputs(", ", out);
            fprintf(out, "(%s)s%d", c_type_for_desc(c_at[a]), base + a);
          }
          fputs(");\n", out);
        }
        break;
      }
      case 0xbb: { /* new */
        uint16_t class_idx = aot_u16(code, pc + 1);
        fprintf(out, "  s%d = b8g_new_obj(%u);\n", d, class_idx);
        break;
      }

      /* Arrays */
      case 0xbc: { /* newarray */
        uint8_t atype = code[pc + 1];
        if (atype == JVM_T_BYTE || atype == JVM_T_BOOLEAN) {
          fprintf(out, "  s%d = (int64_t)(intptr_t)b8g_new_barr((int32_t)s%d);\n",
                  d - 1, d - 1);
        } else {
          fprintf(out, "  s%d = (int64_t)(intptr_t)b8g_new_iarr((int32_t)s%d);\n",
                  d - 1, d - 1);
        }
        break;
      }
      case 0xbe: /* arraylength */
        fprintf(out, "  s%d = ((b8g_arr_t *)(intptr_t)s%d)->len;\n", d - 1, d - 1);
        break;

      default:
        break;
    }

    pc += ilen;
  }

  fputs("}\n\n", out);

  free(local_types);
  free(depth);
  free(is_target);
  free(worklist);
  return 0;
}

int b8g_jvm_emit_c(const b8g_jvm_class_t *cls, FILE *out,
                   char *err, size_t err_cap) {
  if (!cls || !out) {
    aot_err(err, err_cap, "invalid arguments to emit_c");
    return -1;
  }

  fputs("/* Generated by " B8G_JVM_VERSION_STR " */\n", out);
  fputs("#define _POSIX_C_SOURCE 200809L\n", out);
  fputs("#include <inttypes.h>\n", out);
  fputs("#include <stdint.h>\n", out);
  fputs("#include <stdio.h>\n", out);
  fputs("#include <stdlib.h>\n\n", out);
  fputs("#ifdef _WIN32\n", out);
  fputs("#define WIN32_LEAN_AND_MEAN\n", out);
  fputs("#include <windows.h>\n", out);
  fputs("static inline int64_t b8g_aot_nanotime(void) {\n", out);
  fputs("  static LARGE_INTEGER f = {0}; LARGE_INTEGER c;\n", out);
  fputs("  if (!f.QuadPart) QueryPerformanceFrequency(&f);\n", out);
  fputs("  QueryPerformanceCounter(&c);\n", out);
  fputs("  return (c.QuadPart / f.QuadPart) * 1000000000LL +\n", out);
  fputs("         ((c.QuadPart % f.QuadPart) * 1000000000LL) / f.QuadPart;\n", out);
  fputs("}\n", out);
  fputs("#else\n", out);
  fputs("#include <time.h>\n", out);
  fputs("static inline int64_t b8g_aot_nanotime(void) {\n", out);
  fputs("  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);\n", out);
  fputs("  return (int64_t)ts.tv_sec * 1000000000LL + (int64_t)ts.tv_nsec;\n", out);
  fputs("}\n", out);
  fputs("#endif\n\n", out);

  fputs("typedef struct {\n", out);
  fputs("  int32_t len;\n", out);
  fputs("  union { int32_t *i32; int8_t *i8; };\n", out);
  fputs("} b8g_arr_t;\n\n", out);
  fputs("static inline b8g_arr_t *b8g_new_iarr(int32_t n) {\n", out);
  fputs("  b8g_arr_t *a = (b8g_arr_t *)calloc(1, sizeof(b8g_arr_t));\n", out);
  fputs("  a->len = n; a->i32 = (int32_t *)calloc(n > 0 ? (size_t)n : 1, 4);\n", out);
  fputs("  return a;\n}\n", out);
  fputs("static inline b8g_arr_t *b8g_new_barr(int32_t n) {\n", out);
  fputs("  b8g_arr_t *a = (b8g_arr_t *)calloc(1, sizeof(b8g_arr_t));\n", out);
  fputs("  a->len = n; a->i8 = (int8_t *)calloc(n > 0 ? (size_t)n : 1, 1);\n", out);
  fputs("  return a;\n}\n\n", out);

  fputs("typedef struct {\n", out);
  fputs("  uint16_t class_idx;\n", out);
  fputs("  uint8_t field_count;\n", out);
  fputs("  uint16_t field_keys[16];\n", out);
  fputs("  int64_t field_vals[16];\n", out);
  fputs("} b8g_obj_t;\n", out);
  fputs("static b8g_obj_t b8g_objs[4096];\n", out);
  fputs("static uint32_t b8g_obj_count = 0;\n", out);
  fputs("static inline int64_t b8g_new_obj(uint16_t cls_idx) {\n", out);
  fputs("  if (b8g_obj_count >= 4096u) return 0;\n", out);
  fputs("  uint32_t id = ++b8g_obj_count;\n", out);
  fputs("  b8g_objs[id - 1].class_idx = cls_idx;\n", out);
  fputs("  b8g_objs[id - 1].field_count = 0;\n", out);
  fputs("  return (int64_t)id;\n}\n", out);
  fputs("static inline void b8g_putfield(int64_t h, uint16_t k, int64_t v) {\n", out);
  fputs("  if (h <= 0 || (uint32_t)h > b8g_obj_count) return;\n", out);
  fputs("  b8g_obj_t *o = &b8g_objs[(uint32_t)h - 1];\n", out);
  fputs("  for (uint8_t i = 0; i < o->field_count; i++) {\n", out);
  fputs("    if (o->field_keys[i] == k) { o->field_vals[i] = v; return; }\n", out);
  fputs("  }\n", out);
  fputs("  if (o->field_count < 16) {\n", out);
  fputs("    uint8_t s = o->field_count++; o->field_keys[s] = k; o->field_vals[s] = v;\n", out);
  fputs("  }\n}\n", out);
  fputs("static inline int64_t b8g_getfield(int64_t h, uint16_t k) {\n", out);
  fputs("  if (h <= 0 || (uint32_t)h > b8g_obj_count) return 0;\n", out);
  fputs("  b8g_obj_t *o = &b8g_objs[(uint32_t)h - 1];\n", out);
  fputs("  for (uint8_t i = 0; i < o->field_count; i++) {\n", out);
  fputs("    if (o->field_keys[i] == k) return o->field_vals[i];\n", out);
  fputs("  }\n  return 0;\n}\n", out);
  fputs("typedef struct { uint16_t key; int64_t val; } b8g_static_t;\n", out);
  fputs("static b8g_static_t b8g_statics[256];\n", out);
  fputs("static uint16_t b8g_static_count = 0;\n", out);
  fputs("static inline void b8g_putstatic(uint16_t k, int64_t v) {\n", out);
  fputs("  for (uint16_t i = 0; i < b8g_static_count; i++) {\n", out);
  fputs("    if (b8g_statics[i].key == k) { b8g_statics[i].val = v; return; }\n", out);
  fputs("  }\n", out);
  fputs("  if (b8g_static_count < 256) {\n", out);
  fputs("    b8g_statics[b8g_static_count].key = k;\n", out);
  fputs("    b8g_statics[b8g_static_count].val = v;\n", out);
  fputs("    b8g_static_count++;\n", out);
  fputs("  }\n}\n", out);
  fputs("static inline int64_t b8g_getstatic(uint16_t k) {\n", out);
  fputs("  for (uint16_t i = 0; i < b8g_static_count; i++) {\n", out);
  fputs("    if (b8g_statics[i].key == k) return b8g_statics[i].val;\n", out);
  fputs("  }\n  return 0;\n}\n\n", out);

  /* Forward declarations for methods with Code (static + <init> / instance) */
  int main_idx = -1;
  int main_has_args = 0;
  for (uint16_t i = 0; i < cls->methods_count; i++) {
    const b8g_method_t *m = &cls->methods[i];
    if (!m->has_code) continue;
    if (m->name && strcmp(m->name, "<clinit>") == 0) continue;
    if (emit_method_sig(cls, i, out, 1) != 0) {
      aot_err(err, err_cap, "bad descriptor for method %s",
              m->name ? m->name : "<unknown>");
      return -1;
    }
    if ((m->access_flags & JVM_ACC_STATIC) && m->name &&
        strcmp(m->name, "main") == 0) {
      if (m->desc && strcmp(m->desc, "([Ljava/lang/String;)V") == 0) {
        main_idx = (int)i;
        main_has_args = 1;
      } else if (main_idx < 0 && m->desc && strcmp(m->desc, "()V") == 0) {
        main_idx = (int)i;
        main_has_args = 0;
      }
    }
  }
  fputc('\n', out);

  /* Emit method bodies */
  for (uint16_t i = 0; i < cls->methods_count; i++) {
    const b8g_method_t *m = &cls->methods[i];
    if (!m->has_code) continue;
    if (m->name && strcmp(m->name, "<clinit>") == 0) continue;
    if (emit_method_body(cls, i, out, err, err_cap) != 0) return -1;
  }

  /* Emit C main() entrypoint */
  fputs("int main(void) {\n", out);
  fputs("  (void)b8g_aot_nanotime; (void)b8g_new_iarr; (void)b8g_new_barr;\n", out);
  fputs("  (void)b8g_new_obj; (void)b8g_putfield; (void)b8g_getfield;\n", out);
  fputs("  (void)b8g_putstatic; (void)b8g_getstatic;\n", out);
  if (main_idx >= 0) {
    char cname[128];
    sanitize_method_name(cls, (uint16_t)main_idx, cname, sizeof(cname));
    if (main_has_args) {
      fprintf(out, "  %s(0);\n", cname);
    } else {
      fprintf(out, "  %s();\n", cname);
    }
  }
  fputs("  return 0;\n}\n", out);
  return 0;
}
