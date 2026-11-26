#include "b8g_sectium_cp_abi.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>

static int fail(const char* step, int32_t rc) {
    fprintf(stderr, "FAIL: %s (rc=%" PRId32 ")\n", step, rc);
    return 1;
}

int main(void) {
    uint32_t magic = sectium_cp_abi_magic();
    if (magic != B8G_ABI_MAGIC_V3) {
        return fail("abi_magic", (int32_t)magic);
    }

    SectiumCpHandle* h = sectium_cp_create("sectium://control-plane.local:9443");
    if (h == NULL) {
        return fail("create", -1);
    }

    /* 1. Offline attach must return ERR_DEVICE_OFFLINE */
    uint32_t offline_slot = 0u;
    uint32_t offline_replaced = 0u;
    int32_t rc = sectium_cp_attach_channel(
        h,
        SECTIUM_CP_CHANNEL_COMMAND,
        "peer-offline",
        &offline_slot,
        &offline_replaced
    );
    if (rc != SECTIUM_CP_ERR_DEVICE_OFFLINE) {
        sectium_cp_destroy(h);
        return fail("offline_attach_expected_ERR_DEVICE_OFFLINE", rc);
    }

    /* 2. WoL cold wake */
    rc = sectium_cp_wol_wake(h, SECTIUM_CP_POWER_COLD_INIT, 0u);
    if (rc != SECTIUM_CP_OK) {
        sectium_cp_destroy(h);
        return fail("wol_cold_wake", rc);
    }

    /* 3. RAM checkpoint (epoch=1) */
    uint64_t epoch = 0u;
    rc = sectium_cp_checkpoint_ram(h, &epoch);
    if (rc != SECTIUM_CP_OK || epoch != 1u) {
        sectium_cp_destroy(h);
        return fail("checkpoint_ram", rc);
    }

    /* 4. Power off (must preserve snapshot_epoch) */
    rc = sectium_cp_power_off(h);
    if (rc != SECTIUM_CP_OK) {
        sectium_cp_destroy(h);
        return fail("power_off", rc);
    }

    SectiumCpStatus st_off;
    rc = sectium_cp_status(h, &st_off);
    if (rc != SECTIUM_CP_OK || st_off.online != 0u || st_off.snapshot_epoch != 1u) {
        sectium_cp_destroy(h);
        return fail("status_after_power_off", rc);
    }

    /* 5. WoL warm resume (warm_resumed=1, epoch=1) */
    rc = sectium_cp_wol_wake(h, SECTIUM_CP_POWER_WARM_RAM_RESUME, epoch);
    if (rc != SECTIUM_CP_OK) {
        sectium_cp_destroy(h);
        return fail("wol_warm_resume", rc);
    }

    SectiumCpStatus st_warm;
    rc = sectium_cp_status(h, &st_warm);
    if (rc != SECTIUM_CP_OK || st_warm.online != 1u ||
        st_warm.warm_resumed != 1u || st_warm.snapshot_epoch != 1u) {
        sectium_cp_destroy(h);
        return fail("status_after_warm_resume", rc);
    }

    /* 6. Attach COMMAND + DEVTOOLS + DISPLAY #1 */
    uint32_t cmd_slot = 0u, cmd_rep = 0u;
    uint32_t dev_slot = 0u, dev_rep = 0u;
    uint32_t disp_slot1 = 0u, disp_rep1 = 0u;

    rc = sectium_cp_attach_channel(h, SECTIUM_CP_CHANNEL_COMMAND, "cmd-1", &cmd_slot, &cmd_rep);
    if (rc != SECTIUM_CP_OK || cmd_slot == 0u || cmd_rep != 0u) {
        sectium_cp_destroy(h);
        return fail("attach_command", rc);
    }

    rc = sectium_cp_attach_channel(h, SECTIUM_CP_CHANNEL_DEVTOOLS, "devtools-1", &dev_slot, &dev_rep);
    if (rc != SECTIUM_CP_OK || dev_slot == 0u || dev_rep != 0u) {
        sectium_cp_destroy(h);
        return fail("attach_devtools", rc);
    }

    rc = sectium_cp_attach_channel(h, SECTIUM_CP_CHANNEL_DISPLAY, "display-1", &disp_slot1, &disp_rep1);
    if (rc != SECTIUM_CP_OK || disp_slot1 == 0u || disp_rep1 != 0u) {
        sectium_cp_destroy(h);
        return fail("attach_display_1", rc);
    }

    /* 7. Hot-swap DISPLAY #2 (replaced_slot_id == disp_slot1, command_peers == 1) */
    uint32_t disp_slot2 = 0u, disp_rep2 = 0u;
    rc = sectium_cp_attach_channel(h, SECTIUM_CP_CHANNEL_DISPLAY, "display-2", &disp_slot2, &disp_rep2);
    if (rc != SECTIUM_CP_OK || disp_slot2 == 0u || disp_slot2 == disp_slot1 || disp_rep2 != disp_slot1) {
        sectium_cp_destroy(h);
        return fail("hotswap_display_2", rc);
    }

    SectiumCpStatus st_final;
    rc = sectium_cp_status(h, &st_final);
    if (rc != SECTIUM_CP_OK ||
        st_final.abi_magic != B8G_ABI_MAGIC_V3 ||
        st_final.abi_version != B8G_CP_ABI_VERSION ||
        st_final.online != 1u ||
        st_final.warm_resumed != 1u ||
        st_final.snapshot_epoch != 1u ||
        st_final.command_peers != 1u ||
        st_final.display_peers != 1u ||
        st_final.devtools_peers != 1u ||
        st_final.last_error != SECTIUM_CP_OK) {
        sectium_cp_destroy(h);
        return fail("final_status_check", rc);
    }

    printf(
        "{\"ok\":true,\"abi_magic\":\"0x%08" PRIX32 "\",\"abi_version\":%" PRIu32
        ",\"offline_rc\":%" PRId32 ",\"online\":%u,\"detached\":%u,\"warm_resumed\":%u"
        ",\"snapshot_epoch\":%" PRIu64 ",\"command_peers\":%" PRIu32
        ",\"display_peers\":%" PRIu32 ",\"devtools_peers\":%" PRIu32
        ",\"display_slot1\":%" PRIu32 ",\"display_slot2\":%" PRIu32
        ",\"replaced_slot_id\":%" PRIu32 ",\"last_error\":%" PRId32 "}\n",
        st_final.abi_magic,
        st_final.abi_version,
        (int32_t)SECTIUM_CP_ERR_DEVICE_OFFLINE,
        (unsigned)st_final.online,
        (unsigned)st_final.detached,
        (unsigned)st_final.warm_resumed,
        st_final.snapshot_epoch,
        st_final.command_peers,
        st_final.display_peers,
        st_final.devtools_peers,
        disp_slot1,
        disp_slot2,
        disp_rep2,
        st_final.last_error
    );

    sectium_cp_destroy(h);
    return 0;
}
