#include "b8g_sectium_cp_abi.h"

#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#define SECTIUM_CP_MAX_SLOTS    64u
#define SECTIUM_CP_MAX_ENDPOINT 256u
#define SECTIUM_CP_MAX_PEER_ID  128u

_Static_assert(sizeof(SectiumCpStatus) == 40u, "SectiumCpStatus ABI layout mismatch");

typedef struct SectiumCpSlot {
    uint8_t  active;
    uint32_t slot_id;
    uint32_t kind;
    char     peer_id[SECTIUM_CP_MAX_PEER_ID];
} SectiumCpSlot;

struct SectiumCpHandle {
    uint32_t      abi_magic;
    uint32_t      abi_version;
    char          endpoint[SECTIUM_CP_MAX_ENDPOINT];
    uint8_t       online;
    uint8_t       detached;
    uint8_t       warm_resumed;
    uint64_t      snapshot_epoch;
    int32_t       last_error;
    uint32_t      next_slot_id;
    SectiumCpSlot slots[SECTIUM_CP_MAX_SLOTS];
};

static void sectium_cp_copy_str(char* dst, size_t dst_cap, const char* src) {
    if (dst == NULL || dst_cap == 0u) {
        return;
    }
    if (src == NULL) {
        dst[0] = '\0';
        return;
    }
    size_t i = 0u;
    while (i + 1u < dst_cap && src[i] != '\0') {
        dst[i] = src[i];
        i++;
    }
    dst[i] = '\0';
}

static uint32_t sectium_cp_alloc_slot_id(SectiumCpHandle* h) {
    uint32_t id = h->next_slot_id++;
    if (id == 0u) {
        id = h->next_slot_id++;
    }
    return id;
}

B8G_CP_EXPORT uint32_t sectium_cp_abi_magic(void) {
    return B8G_ABI_MAGIC_V3;
}

B8G_CP_EXPORT SectiumCpHandle* sectium_cp_create(const char* endpoint) {
    SectiumCpHandle* h = (SectiumCpHandle*)calloc(1u, sizeof(SectiumCpHandle));
    if (h == NULL) {
        return NULL;
    }
    h->abi_magic = B8G_ABI_MAGIC_V3;
    h->abi_version = B8G_CP_ABI_VERSION;
    h->next_slot_id = 1u;
    h->last_error = SECTIUM_CP_OK;
    sectium_cp_copy_str(h->endpoint, sizeof(h->endpoint), endpoint);
    return h;
}

B8G_CP_EXPORT int32_t sectium_cp_wol_wake(
    SectiumCpHandle* h,
    uint32_t power_mode,
    uint64_t resume_epoch
) {
    if (h == NULL) {
        return SECTIUM_CP_ERR_INVALID_ARG;
    }

    switch (power_mode) {
        case SECTIUM_CP_POWER_COLD_INIT:
            h->online = 1u;
            h->detached = 0u;
            h->warm_resumed = 0u;
            h->last_error = SECTIUM_CP_OK;
            return SECTIUM_CP_OK;

        case SECTIUM_CP_POWER_WARM_RAM_RESUME:
            if (h->snapshot_epoch == 0u) {
                h->last_error = SECTIUM_CP_ERR_NO_SNAPSHOT;
                return SECTIUM_CP_ERR_NO_SNAPSHOT;
            }
            if (resume_epoch != 0u && resume_epoch > h->snapshot_epoch) {
                h->last_error = SECTIUM_CP_ERR_NO_SNAPSHOT;
                return SECTIUM_CP_ERR_NO_SNAPSHOT;
            }
            if (resume_epoch != 0u) {
                h->snapshot_epoch = resume_epoch;
            }
            h->online = 1u;
            h->detached = 0u;
            h->warm_resumed = 1u;
            h->last_error = SECTIUM_CP_OK;
            return SECTIUM_CP_OK;

        case SECTIUM_CP_POWER_DETACHED_DAEMON:
            h->online = 1u;
            h->detached = 1u;
            if (h->snapshot_epoch > 0u && resume_epoch > 0u && resume_epoch <= h->snapshot_epoch) {
                h->snapshot_epoch = resume_epoch;
                h->warm_resumed = 1u;
            } else {
                h->warm_resumed = 0u;
            }
            h->last_error = SECTIUM_CP_OK;
            return SECTIUM_CP_OK;

        default:
            h->last_error = SECTIUM_CP_ERR_INVALID_ARG;
            return SECTIUM_CP_ERR_INVALID_ARG;
    }
}

B8G_CP_EXPORT int32_t sectium_cp_checkpoint_ram(
    SectiumCpHandle* h,
    uint64_t* out_epoch
) {
    if (h == NULL) {
        return SECTIUM_CP_ERR_INVALID_ARG;
    }
    if (h->online == 0u) {
        h->last_error = SECTIUM_CP_ERR_DEVICE_OFFLINE;
        return SECTIUM_CP_ERR_DEVICE_OFFLINE;
    }

    h->snapshot_epoch += 1u;
    if (out_epoch != NULL) {
        *out_epoch = h->snapshot_epoch;
    }
    h->last_error = SECTIUM_CP_OK;
    return SECTIUM_CP_OK;
}

B8G_CP_EXPORT int32_t sectium_cp_attach_channel(
    SectiumCpHandle* h,
    uint32_t kind,
    const char* peer_id,
    uint32_t* out_slot_id,
    uint32_t* out_replaced_slot_id
) {
    if (out_slot_id != NULL) {
        *out_slot_id = 0u;
    }
    if (out_replaced_slot_id != NULL) {
        *out_replaced_slot_id = 0u;
    }
    if (h == NULL) {
        return SECTIUM_CP_ERR_INVALID_ARG;
    }
    if (peer_id == NULL || peer_id[0] == '\0') {
        h->last_error = SECTIUM_CP_ERR_INVALID_ARG;
        return SECTIUM_CP_ERR_INVALID_ARG;
    }
    if (kind != SECTIUM_CP_CHANNEL_COMMAND &&
        kind != SECTIUM_CP_CHANNEL_DISPLAY &&
        kind != SECTIUM_CP_CHANNEL_DEVTOOLS) {
        h->last_error = SECTIUM_CP_ERR_INVALID_ARG;
        return SECTIUM_CP_ERR_INVALID_ARG;
    }
    if (h->online == 0u) {
        h->last_error = SECTIUM_CP_ERR_DEVICE_OFFLINE;
        return SECTIUM_CP_ERR_DEVICE_OFFLINE;
    }

    /* Atomic hot-swap for DISPLAY channel: replace active DISPLAY slot in-place,
       leaving all COMMAND and DEVTOOLS slots completely untouched. */
    if (kind == SECTIUM_CP_CHANNEL_DISPLAY) {
        for (uint32_t i = 0u; i < SECTIUM_CP_MAX_SLOTS; i++) {
            if (h->slots[i].active != 0u && h->slots[i].kind == SECTIUM_CP_CHANNEL_DISPLAY) {
                uint32_t old_slot_id = h->slots[i].slot_id;
                uint32_t new_slot_id = sectium_cp_alloc_slot_id(h);
                h->slots[i].slot_id = new_slot_id;
                sectium_cp_copy_str(h->slots[i].peer_id, sizeof(h->slots[i].peer_id), peer_id);
                if (out_slot_id != NULL) {
                    *out_slot_id = new_slot_id;
                }
                if (out_replaced_slot_id != NULL) {
                    *out_replaced_slot_id = old_slot_id;
                }
                h->last_error = SECTIUM_CP_OK;
                return SECTIUM_CP_OK;
            }
        }
    }

    for (uint32_t i = 0u; i < SECTIUM_CP_MAX_SLOTS; i++) {
        if (h->slots[i].active == 0u) {
            uint32_t new_slot_id = sectium_cp_alloc_slot_id(h);
            h->slots[i].active = 1u;
            h->slots[i].slot_id = new_slot_id;
            h->slots[i].kind = kind;
            sectium_cp_copy_str(h->slots[i].peer_id, sizeof(h->slots[i].peer_id), peer_id);
            if (out_slot_id != NULL) {
                *out_slot_id = new_slot_id;
            }
            if (out_replaced_slot_id != NULL) {
                *out_replaced_slot_id = 0u;
            }
            h->last_error = SECTIUM_CP_OK;
            return SECTIUM_CP_OK;
        }
    }

    h->last_error = SECTIUM_CP_ERR_SLOTS_FULL;
    return SECTIUM_CP_ERR_SLOTS_FULL;
}

B8G_CP_EXPORT int32_t sectium_cp_detach_channel(
    SectiumCpHandle* h,
    uint32_t slot_id
) {
    if (h == NULL) {
        return SECTIUM_CP_ERR_INVALID_ARG;
    }
    if (slot_id == 0u) {
        h->last_error = SECTIUM_CP_ERR_INVALID_ARG;
        return SECTIUM_CP_ERR_INVALID_ARG;
    }

    for (uint32_t i = 0u; i < SECTIUM_CP_MAX_SLOTS; i++) {
        if (h->slots[i].active != 0u && h->slots[i].slot_id == slot_id) {
            memset(&h->slots[i], 0, sizeof(h->slots[i]));
            h->last_error = SECTIUM_CP_OK;
            return SECTIUM_CP_OK;
        }
    }

    h->last_error = SECTIUM_CP_ERR_INVALID_ARG;
    return SECTIUM_CP_ERR_INVALID_ARG;
}

B8G_CP_EXPORT int32_t sectium_cp_power_off(SectiumCpHandle* h) {
    if (h == NULL) {
        return SECTIUM_CP_ERR_INVALID_ARG;
    }

    h->online = 0u;
    h->detached = 0u;
    h->warm_resumed = 0u;
    memset(h->slots, 0, sizeof(h->slots));
    /* snapshot_epoch is intentionally preserved for warm RAM resume. */
    h->last_error = SECTIUM_CP_OK;
    return SECTIUM_CP_OK;
}

B8G_CP_EXPORT int32_t sectium_cp_status(
    const SectiumCpHandle* h,
    SectiumCpStatus* out_status
) {
    if (h == NULL || out_status == NULL) {
        return SECTIUM_CP_ERR_INVALID_ARG;
    }

    memset(out_status, 0, sizeof(*out_status));
    out_status->abi_magic = h->abi_magic;
    out_status->abi_version = h->abi_version;
    out_status->online = h->online;
    out_status->detached = h->detached;
    out_status->warm_resumed = h->warm_resumed;
    out_status->_pad = 0u;
    out_status->snapshot_epoch = h->snapshot_epoch;
    out_status->last_error = h->last_error;

    uint32_t cmd_count = 0u;
    uint32_t disp_count = 0u;
    uint32_t dev_count = 0u;
    for (uint32_t i = 0u; i < SECTIUM_CP_MAX_SLOTS; i++) {
        if (h->slots[i].active == 0u) {
            continue;
        }
        if (h->slots[i].kind == SECTIUM_CP_CHANNEL_COMMAND) {
            cmd_count++;
        } else if (h->slots[i].kind == SECTIUM_CP_CHANNEL_DISPLAY) {
            disp_count++;
        } else if (h->slots[i].kind == SECTIUM_CP_CHANNEL_DEVTOOLS) {
            dev_count++;
        }
    }

    out_status->command_peers = cmd_count;
    out_status->display_peers = disp_count;
    out_status->devtools_peers = dev_count;
    return SECTIUM_CP_OK;
}

B8G_CP_EXPORT void sectium_cp_destroy(SectiumCpHandle* h) {
    if (h != NULL) {
        free(h);
    }
}
