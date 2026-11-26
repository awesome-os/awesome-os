#include "sectium_display.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

_Static_assert(B8G_DISPLAY_MAGIC_V1 == 0x31444742u, "B8G_DISPLAY_MAGIC_V1 must equal BGD1");
_Static_assert(sizeof(B8GDamageRect) == 16u, "B8GDamageRect ABI layout mismatch");
_Static_assert(sizeof(B8GWorldPose) == 32u, "B8GWorldPose ABI layout mismatch");
_Static_assert(sizeof(B8GDisplayStats) == 80u, "B8GDisplayStats ABI layout mismatch");

static void display_copy_name(char* dst, size_t cap, const char* src) {
    if (dst == NULL || cap == 0u) {
        return;
    }
    if (src == NULL) {
        dst[0] = '\0';
        return;
    }
    size_t i = 0u;
    while (i + 1u < cap && src[i] != '\0') {
        dst[i] = src[i];
        i++;
    }
    dst[i] = '\0';
}

static int ctx_is_valid(const B8GDisplayCtx* ctx) {
    return ctx != NULL
        && ctx->abi_magic == B8G_DISPLAY_MAGIC_V1
        && ctx->abi_version == B8G_DISPLAY_ABI_VERSION;
}

static B8GActor* find_actor(B8GDisplayCtx* ctx, uint32_t actor_id) {
    if (actor_id == 0u) {
        return NULL;
    }
    for (uint32_t i = 0u; i < B8G_DISPLAY_MAX_ACTORS; i++) {
        if (ctx->actors[i].active && ctx->actors[i].actor_id == actor_id) {
            return &ctx->actors[i];
        }
    }
    return NULL;
}

static B8GSurface* find_surface(B8GDisplayCtx* ctx, uint32_t surface_id) {
    if (surface_id == 0u) {
        return NULL;
    }
    for (uint32_t i = 0u; i < B8G_DISPLAY_MAX_SURFACES; i++) {
        if (ctx->surfaces[i].active && ctx->surfaces[i].surface_id == surface_id) {
            return &ctx->surfaces[i];
        }
    }
    return NULL;
}

static uint32_t alloc_id(uint32_t* counter) {
    uint32_t id = (*counter)++;
    if (id == 0u) {
        id = (*counter)++;
    }
    return id;
}

static int is_valid_actor_kind(uint32_t kind) {
    return kind == B8G_ACTOR_HUMAN
        || kind == B8G_ACTOR_AGENT
        || kind == B8G_ACTOR_WORKER;
}

static int is_valid_stream_kind(uint32_t kind) {
    return kind == B8G_STREAM_SURFACE
        || kind == B8G_STREAM_AVATAR
        || kind == B8G_STREAM_DIALOG
        || kind == B8G_STREAM_WORKER_IO;
}

static int is_valid_compositor_mode(uint32_t mode) {
    return mode == B8G_COMP_TILING_2D || mode == B8G_COMP_OPEN_WORLD_3D;
}

B8G_DISPLAY_EXPORT int32_t sectium_display_init(B8GDisplayCtx* ctx) {
    if (ctx == NULL) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }
    memset(ctx, 0, sizeof(*ctx));
    ctx->abi_magic       = B8G_DISPLAY_MAGIC_V1;
    ctx->abi_version     = B8G_DISPLAY_ABI_VERSION;
    ctx->next_actor_id   = 1u;
    ctx->next_surface_id = 1u;
    ctx->next_binding_id = 1u;
    return B8G_DISPLAY_OK;
}

B8G_DISPLAY_EXPORT int32_t sectium_actor_register(
    B8GDisplayCtx* ctx,
    uint32_t kind,
    const char* name,
    uint32_t* out_actor_id
) {
    if (!ctx_is_valid(ctx) || !is_valid_actor_kind(kind) || out_actor_id == NULL) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }

    for (uint32_t i = 0u; i < B8G_DISPLAY_MAX_ACTORS; i++) {
        if (!ctx->actors[i].active) {
            B8GActor* a = &ctx->actors[i];
            memset(a, 0, sizeof(*a));
            a->active   = 1u;
            a->actor_id = alloc_id(&ctx->next_actor_id);
            a->kind     = kind;
            display_copy_name(a->name, sizeof(a->name), name);
            *out_actor_id = a->actor_id;
            return B8G_DISPLAY_OK;
        }
    }

    return B8G_DISPLAY_ERR_CAPACITY;
}

B8G_DISPLAY_EXPORT int32_t sectium_surface_create(
    B8GDisplayCtx* ctx,
    uint32_t owner_actor_id,
    uint32_t width,
    uint32_t height,
    uint32_t compositor_mode,
    uint32_t* out_surface_id
) {
    if (!ctx_is_valid(ctx)
        || width == 0u
        || height == 0u
        || !is_valid_compositor_mode(compositor_mode)
        || out_surface_id == NULL) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }

    if (find_actor(ctx, owner_actor_id) == NULL) {
        return B8G_DISPLAY_ERR_NOT_FOUND;
    }

    for (uint32_t i = 0u; i < B8G_DISPLAY_MAX_SURFACES; i++) {
        if (!ctx->surfaces[i].active) {
            B8GSurface* s = &ctx->surfaces[i];
            memset(s, 0, sizeof(*s));
            s->active          = 1u;
            s->surface_id      = alloc_id(&ctx->next_surface_id);
            s->owner_actor_id  = owner_actor_id;
            s->width           = width;
            s->height          = height;
            s->stride          = width * 4u;
            s->state           = B8G_SURFACE_ACTIVE;
            s->compositor_mode = compositor_mode;
            s->wake_leases     = B8G_LEASE_NONE;
            s->pose.rot_w      = 1.0f;
            s->pose.scale      = 1.0f;
            *out_surface_id    = s->surface_id;
            return B8G_DISPLAY_OK;
        }
    }

    return B8G_DISPLAY_ERR_CAPACITY;
}

B8G_DISPLAY_EXPORT int32_t sectium_actor_bind_stream(
    B8GDisplayCtx* ctx,
    uint32_t actor_id,
    uint32_t surface_id,
    uint32_t stream_kind,
    uint32_t* out_binding_id
) {
    if (!ctx_is_valid(ctx)
        || !is_valid_stream_kind(stream_kind)
        || out_binding_id == NULL) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }

    B8GActor* actor = find_actor(ctx, actor_id);
    B8GSurface* surface = find_surface(ctx, surface_id);
    if (actor == NULL || surface == NULL) {
        return B8G_DISPLAY_ERR_NOT_FOUND;
    }

    for (uint32_t i = 0u; i < B8G_DISPLAY_MAX_BINDINGS; i++) {
        if (!ctx->bindings[i].active) {
            B8GStreamBinding* b = &ctx->bindings[i];
            memset(b, 0, sizeof(*b));
            b->active      = 1u;
            b->binding_id  = alloc_id(&ctx->next_binding_id);
            b->actor_id    = actor_id;
            b->surface_id  = surface_id;
            b->stream_kind = stream_kind;
            actor->binding_count++;
            *out_binding_id = b->binding_id;
            return B8G_DISPLAY_OK;
        }
    }

    return B8G_DISPLAY_ERR_CAPACITY;
}

B8G_DISPLAY_EXPORT int32_t sectium_surface_attach_arena(
    B8GDisplayCtx* ctx,
    uint32_t surface_id,
    uint64_t arena_offset,
    uint64_t arena_size,
    uint32_t stride
) {
    if (!ctx_is_valid(ctx) || arena_size == 0u || stride == 0u) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }
    if ((arena_offset & (uint64_t)(B8G_DISPLAY_ARENA_ALIGN - 1u)) != 0u) {
        return B8G_DISPLAY_ERR_UNALIGNED;
    }

    B8GSurface* s = find_surface(ctx, surface_id);
    if (s == NULL) {
        return B8G_DISPLAY_ERR_NOT_FOUND;
    }

    uint64_t min_bytes = (uint64_t)stride * (uint64_t)s->height;
    if (arena_size < min_bytes) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }

    s->arena_offset = arena_offset;
    s->arena_size   = arena_size;
    s->stride       = stride;
    return B8G_DISPLAY_OK;
}

B8G_DISPLAY_EXPORT int32_t sectium_surface_damage(
    B8GDisplayCtx* ctx,
    uint32_t surface_id,
    int32_t x,
    int32_t y,
    uint32_t width,
    uint32_t height
) {
    if (!ctx_is_valid(ctx) || width == 0u || height == 0u) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }

    B8GSurface* s = find_surface(ctx, surface_id);
    if (s == NULL) {
        return B8G_DISPLAY_ERR_NOT_FOUND;
    }

    if (s->state == B8G_SURFACE_FROZEN || s->state == B8G_SURFACE_CHECKPOINTED) {
        return B8G_DISPLAY_ERR_INVALID_STATE;
    }

    if (s->damage_count < B8G_DISPLAY_MAX_DAMAGE) {
        B8GDamageRect* r = &s->damage[s->damage_count++];
        r->x      = x;
        r->y      = y;
        r->width  = width;
        r->height = height;
    } else {
        /* Coalesce overflow into full-surface damage at slot 0 */
        s->damage[0].x      = 0;
        s->damage[0].y      = 0;
        s->damage[0].width  = s->width;
        s->damage[0].height = s->height;
        s->damage_count     = 1u;
    }

    ctx->total_damage_rects++;
    return B8G_DISPLAY_OK;
}

B8G_DISPLAY_EXPORT int32_t sectium_surface_commit(
    B8GDisplayCtx* ctx,
    uint32_t surface_id,
    uint64_t now_ms,
    uint64_t* out_commit_seq
) {
    if (!ctx_is_valid(ctx)) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }

    B8GSurface* s = find_surface(ctx, surface_id);
    if (s == NULL) {
        return B8G_DISPLAY_ERR_NOT_FOUND;
    }

    if (s->state == B8G_SURFACE_FROZEN || s->state == B8G_SURFACE_CHECKPOINTED) {
        return B8G_DISPLAY_ERR_INVALID_STATE;
    }

    s->commit_seq++;
    s->damage_count   = 0u;
    s->last_active_ms = now_ms;
    s->state          = B8G_SURFACE_ACTIVE;
    ctx->total_commits++;

    if (out_commit_seq != NULL) {
        *out_commit_seq = s->commit_seq;
    }
    return B8G_DISPLAY_OK;
}

B8G_DISPLAY_EXPORT int32_t sectium_surface_set_leases(
    B8GDisplayCtx* ctx,
    uint32_t surface_id,
    uint32_t lease_mask
) {
    if (!ctx_is_valid(ctx) || (lease_mask & ~B8G_LEASE_ALL_MASK) != 0u) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }

    B8GSurface* s = find_surface(ctx, surface_id);
    if (s == NULL) {
        return B8G_DISPLAY_ERR_NOT_FOUND;
    }

    s->wake_leases = lease_mask;
    return B8G_DISPLAY_OK;
}

B8G_DISPLAY_EXPORT int32_t sectium_surface_evaluate_idle(
    B8GDisplayCtx* ctx,
    uint32_t surface_id,
    uint64_t now_ms,
    uint64_t idle_threshold_ms,
    uint64_t freeze_threshold_ms,
    uint32_t* out_state
) {
    if (!ctx_is_valid(ctx) || freeze_threshold_ms < idle_threshold_ms) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }

    B8GSurface* s = find_surface(ctx, surface_id);
    if (s == NULL) {
        return B8G_DISPLAY_ERR_NOT_FOUND;
    }

    uint64_t elapsed = (now_ms >= s->last_active_ms)
        ? (now_ms - s->last_active_ms)
        : 0u;

    if (elapsed >= freeze_threshold_ms) {
        if (s->wake_leases != B8G_LEASE_NONE) {
            /* Active wake lease holds surface in DISPLAY_SLEEP instead of freezing */
            s->state = B8G_SURFACE_DISPLAY_SLEEP;
        } else {
            /* No wake leases: step FROZEN -> CHECKPOINTED */
            if (s->state == B8G_SURFACE_FROZEN) {
                s->state = B8G_SURFACE_CHECKPOINTED;
                ctx->checkpoint_counter++;
                s->checkpoint_epoch = ctx->checkpoint_counter;
                ctx->total_checkpoints++;
            } else if (s->state != B8G_SURFACE_CHECKPOINTED) {
                s->state = B8G_SURFACE_FROZEN;
            }
        }
    } else if (elapsed >= idle_threshold_ms) {
        if (s->state == B8G_SURFACE_ACTIVE) {
            s->state = B8G_SURFACE_IDLE;
        }
    }

    if (out_state != NULL) {
        *out_state = s->state;
    }
    return B8G_DISPLAY_OK;
}

B8G_DISPLAY_EXPORT int32_t sectium_surface_thaw(
    B8GDisplayCtx* ctx,
    uint32_t surface_id,
    uint64_t now_ms
) {
    if (!ctx_is_valid(ctx)) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }

    B8GSurface* s = find_surface(ctx, surface_id);
    if (s == NULL) {
        return B8G_DISPLAY_ERR_NOT_FOUND;
    }

    s->state          = B8G_SURFACE_ACTIVE;
    s->last_active_ms = now_ms;
    return B8G_DISPLAY_OK;
}

B8G_DISPLAY_EXPORT int32_t sectium_surface_rebind_mode(
    B8GDisplayCtx* ctx,
    uint32_t surface_id,
    uint32_t new_mode,
    const B8GWorldPose* pose
) {
    if (!ctx_is_valid(ctx) || !is_valid_compositor_mode(new_mode)) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }

    B8GSurface* s = find_surface(ctx, surface_id);
    if (s == NULL) {
        return B8G_DISPLAY_ERR_NOT_FOUND;
    }

    /* Zero-copy rebind: arena_offset, arena_size, stride, commit_seq remain untouched */
    s->compositor_mode = new_mode;
    if (pose != NULL) {
        s->pose = *pose;
    } else if (new_mode == B8G_COMP_TILING_2D) {
        memset(&s->pose, 0, sizeof(s->pose));
        s->pose.rot_w = 1.0f;
        s->pose.scale = 1.0f;
    }
    s->rebind_count++;
    ctx->total_rebinds++;
    return B8G_DISPLAY_OK;
}

B8G_DISPLAY_EXPORT int32_t sectium_display_get_stats(
    const B8GDisplayCtx* ctx,
    B8GDisplayStats* out_stats
) {
    if (!ctx_is_valid(ctx) || out_stats == NULL) {
        return B8G_DISPLAY_ERR_INVALID_ARG;
    }

    memset(out_stats, 0, sizeof(*out_stats));
    out_stats->abi_magic          = ctx->abi_magic;
    out_stats->abi_version        = ctx->abi_version;
    out_stats->total_commits      = ctx->total_commits;
    out_stats->total_damage_rects = ctx->total_damage_rects;
    out_stats->total_rebinds      = ctx->total_rebinds;
    out_stats->total_checkpoints  = ctx->total_checkpoints;

    for (uint32_t i = 0u; i < B8G_DISPLAY_MAX_ACTORS; i++) {
        if (ctx->actors[i].active) {
            out_stats->active_actors++;
        }
    }

    for (uint32_t i = 0u; i < B8G_DISPLAY_MAX_SURFACES; i++) {
        const B8GSurface* s = &ctx->surfaces[i];
        if (!s->active) {
            continue;
        }
        out_stats->active_surfaces++;
        switch (s->state) {
            case B8G_SURFACE_ACTIVE:        out_stats->surfaces_active++;        break;
            case B8G_SURFACE_IDLE:          out_stats->surfaces_idle++;          break;
            case B8G_SURFACE_DISPLAY_SLEEP: out_stats->surfaces_display_sleep++; break;
            case B8G_SURFACE_FROZEN:        out_stats->surfaces_frozen++;        break;
            case B8G_SURFACE_CHECKPOINTED:  out_stats->surfaces_checkpointed++;  break;
            default: break;
        }
        if (s->compositor_mode == B8G_COMP_TILING_2D) {
            out_stats->surfaces_2d++;
        } else if (s->compositor_mode == B8G_COMP_OPEN_WORLD_3D) {
            out_stats->surfaces_3d++;
        }
    }

    for (uint32_t i = 0u; i < B8G_DISPLAY_MAX_BINDINGS; i++) {
        if (ctx->bindings[i].active) {
            out_stats->active_bindings++;
        }
    }

    return B8G_DISPLAY_OK;
}
