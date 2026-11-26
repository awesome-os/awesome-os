#ifndef B8G_SECTIUM_CP_ABI_H
#define B8G_SECTIUM_CP_ABI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define B8G_ABI_MAGIC_V3   0x33564742u
#define B8G_CP_ABI_VERSION 3u

#if defined(_WIN32) || defined(__CYGWIN__)
#  define B8G_CP_EXPORT __declspec(dllexport)
#else
#  define B8G_CP_EXPORT __attribute__((visibility("default")))
#endif

typedef enum SectiumCpPowerMode {
    SECTIUM_CP_POWER_COLD_INIT       = 0,
    SECTIUM_CP_POWER_WARM_RAM_RESUME = 1,
    SECTIUM_CP_POWER_DETACHED_DAEMON = 2
} SectiumCpPowerMode;

typedef enum SectiumCpChannelKind {
    SECTIUM_CP_CHANNEL_COMMAND  = 1,
    SECTIUM_CP_CHANNEL_DISPLAY  = 2,
    SECTIUM_CP_CHANNEL_DEVTOOLS = 3
} SectiumCpChannelKind;

typedef enum SectiumCpError {
    SECTIUM_CP_OK                 = 0,
    SECTIUM_CP_ERR_INVALID_ARG    = -1,
    SECTIUM_CP_ERR_DEVICE_OFFLINE = -2,
    SECTIUM_CP_ERR_NO_SNAPSHOT    = -3,
    SECTIUM_CP_ERR_SLOTS_FULL     = -4
} SectiumCpError;

typedef struct SectiumCpHandle SectiumCpHandle;

typedef struct SectiumCpStatus {
    uint32_t abi_magic;
    uint32_t abi_version;
    uint8_t  online;
    uint8_t  detached;
    uint8_t  warm_resumed;
    uint8_t  _pad;
    uint64_t snapshot_epoch;
    uint32_t command_peers;
    uint32_t display_peers;
    uint32_t devtools_peers;
    int32_t  last_error;
} SectiumCpStatus;

B8G_CP_EXPORT uint32_t sectium_cp_abi_magic(void);
B8G_CP_EXPORT SectiumCpHandle* sectium_cp_create(const char* endpoint);
B8G_CP_EXPORT int32_t sectium_cp_wol_wake(
    SectiumCpHandle* h,
    uint32_t power_mode,
    uint64_t resume_epoch
);
B8G_CP_EXPORT int32_t sectium_cp_checkpoint_ram(
    SectiumCpHandle* h,
    uint64_t* out_epoch
);
B8G_CP_EXPORT int32_t sectium_cp_attach_channel(
    SectiumCpHandle* h,
    uint32_t kind,
    const char* peer_id,
    uint32_t* out_slot_id,
    uint32_t* out_replaced_slot_id
);
B8G_CP_EXPORT int32_t sectium_cp_detach_channel(
    SectiumCpHandle* h,
    uint32_t slot_id
);
B8G_CP_EXPORT int32_t sectium_cp_power_off(SectiumCpHandle* h);
B8G_CP_EXPORT int32_t sectium_cp_status(
    const SectiumCpHandle* h,
    SectiumCpStatus* out_status
);
B8G_CP_EXPORT void sectium_cp_destroy(SectiumCpHandle* h);

#ifdef __cplusplus
}
#endif

#endif /* B8G_SECTIUM_CP_ABI_H */
