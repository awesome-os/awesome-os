#include "sectium_display.h"

#include <stdio.h>
#include <stdlib.h>

static uint32_t g_assertions = 0u;

#define EXPECT(cond)                                                            \
    do {                                                                        \
        g_assertions++;                                                         \
        if (!(cond)) {                                                          \
            fprintf(stderr, "FAIL [%s:%d]: %s\n", __FILE__, __LINE__, #cond);   \
            exit(1);                                                            \
        }                                                                       \
    } while (0)

int main(void) {
    static B8GDisplayCtx ctx;

    /* 1. Initialize context & verify ABI magic/version */
    EXPECT(sectium_display_init(NULL) == B8G_DISPLAY_ERR_INVALID_ARG);
    EXPECT(sectium_display_init(&ctx) == B8G_DISPLAY_OK);
    EXPECT(ctx.abi_magic == B8G_DISPLAY_MAGIC_V1);
    EXPECT(ctx.abi_version == B8G_DISPLAY_ABI_VERSION);

    /* 2. Register Human, Agent, and Worker actors */
    uint32_t human_id = 0u;
    uint32_t agent_id = 0u;
    uint32_t worker_id = 0u;
    EXPECT(sectium_actor_register(&ctx, B8G_ACTOR_HUMAN, "human-operator", &human_id) == B8G_DISPLAY_OK);
    EXPECT(sectium_actor_register(&ctx, B8G_ACTOR_AGENT, "lumi-agent", &agent_id) == B8G_DISPLAY_OK);
    EXPECT(sectium_actor_register(&ctx, B8G_ACTOR_WORKER, "render-worker", &worker_id) == B8G_DISPLAY_OK);
    EXPECT(human_id != 0u && agent_id != 0u && worker_id != 0u);
    EXPECT(human_id != agent_id && agent_id != worker_id);
    EXPECT(sectium_actor_register(&ctx, 99u, "invalid", &worker_id) == B8G_DISPLAY_ERR_INVALID_ARG);

    /* 3. Create 2 surfaces (one for leased sleep, one for freeze->checkpoint) */
    uint32_t surf_main = 0u;
    uint32_t surf_bg = 0u;
    EXPECT(sectium_surface_create(&ctx, human_id, 1920u, 1080u, B8G_COMP_TILING_2D, &surf_main) == B8G_DISPLAY_OK);
    EXPECT(sectium_surface_create(&ctx, agent_id, 1280u, 720u, B8G_COMP_TILING_2D, &surf_bg) == B8G_DISPLAY_OK);
    EXPECT(sectium_surface_create(&ctx, 9999u, 640u, 480u, B8G_COMP_TILING_2D, &surf_bg) == B8G_DISPLAY_ERR_NOT_FOUND);

    /* 4. Attach 64-byte aligned B8G_ARENA_V1 memory buffers */
    const uint64_t main_offset = 4096u;
    const uint64_t main_size   = 1920u * 1080u * 4u;
    const uint64_t bg_offset   = 16u * 1024u * 1024u;
    const uint64_t bg_size     = 1280u * 720u * 4u;
    EXPECT(sectium_surface_attach_arena(&ctx, surf_main, 65u, main_size, 1920u * 4u) == B8G_DISPLAY_ERR_UNALIGNED);
    EXPECT(sectium_surface_attach_arena(&ctx, surf_main, main_offset, main_size, 1920u * 4u) == B8G_DISPLAY_OK);
    EXPECT(sectium_surface_attach_arena(&ctx, surf_bg, bg_offset, bg_size, 1280u * 4u) == B8G_DISPLAY_OK);

    /* 5. Many-to-one stream bindings (avatar + surface + dialog + worker_io on surf_main) */
    uint32_t b_surf = 0u;
    uint32_t b_avatar = 0u;
    uint32_t b_dialog = 0u;
    uint32_t b_worker = 0u;
    EXPECT(sectium_actor_bind_stream(&ctx, human_id, surf_main, B8G_STREAM_SURFACE, &b_surf) == B8G_DISPLAY_OK);
    EXPECT(sectium_actor_bind_stream(&ctx, agent_id, surf_main, B8G_STREAM_AVATAR, &b_avatar) == B8G_DISPLAY_OK);
    EXPECT(sectium_actor_bind_stream(&ctx, agent_id, surf_main, B8G_STREAM_DIALOG, &b_dialog) == B8G_DISPLAY_OK);
    EXPECT(sectium_actor_bind_stream(&ctx, worker_id, surf_main, B8G_STREAM_WORKER_IO, &b_worker) == B8G_DISPLAY_OK);
    EXPECT(b_surf != b_avatar && b_avatar != b_dialog && b_dialog != b_worker);

    /* 6. Damage accumulation & commit */
    uint64_t commit_seq = 0u;
    EXPECT(sectium_surface_damage(&ctx, surf_main, 10, 20, 320u, 240u) == B8G_DISPLAY_OK);
    EXPECT(sectium_surface_damage(&ctx, surf_main, 400, 100, 640u, 480u) == B8G_DISPLAY_OK);
    EXPECT(ctx.surfaces[0].damage_count == 2u);
    EXPECT(sectium_surface_commit(&ctx, surf_main, 1000u, &commit_seq) == B8G_DISPLAY_OK);
    EXPECT(commit_seq == 1u);
    EXPECT(ctx.surfaces[0].damage_count == 0u);
    EXPECT(sectium_surface_commit(&ctx, surf_bg, 1000u, &commit_seq) == B8G_DISPLAY_OK);
    EXPECT(commit_seq == 1u);

    /* 7. 3-bit wake leases: DISPLAY_SLEEP vs FROZEN -> CHECKPOINTED */
    uint32_t state = 0u;
    /* Invalid lease bit rejected */
    EXPECT(sectium_surface_set_leases(&ctx, surf_main, 1u << 5) == B8G_DISPLAY_ERR_INVALID_ARG);
    /* surf_main holds AUDIO | NET_PUSH -> stays in DISPLAY_SLEEP */
    EXPECT(sectium_surface_set_leases(&ctx, surf_main, B8G_LEASE_AUDIO | B8G_LEASE_NET_PUSH) == B8G_DISPLAY_OK);
    EXPECT(sectium_surface_evaluate_idle(&ctx, surf_main, 6000u, 5000u, 15000u, &state) == B8G_DISPLAY_OK);
    EXPECT(state == B8G_SURFACE_IDLE);
    EXPECT(sectium_surface_evaluate_idle(&ctx, surf_main, 20000u, 5000u, 15000u, &state) == B8G_DISPLAY_OK);
    EXPECT(state == B8G_SURFACE_DISPLAY_SLEEP);
    /* Still DISPLAY_SLEEP on repeated evaluation while lease is held */
    EXPECT(sectium_surface_evaluate_idle(&ctx, surf_main, 50000u, 5000u, 15000u, &state) == B8G_DISPLAY_OK);
    EXPECT(state == B8G_SURFACE_DISPLAY_SLEEP);

    /* surf_bg holds B8G_LEASE_NONE -> IDLE -> FROZEN -> CHECKPOINTED */
    EXPECT(sectium_surface_set_leases(&ctx, surf_bg, B8G_LEASE_NONE) == B8G_DISPLAY_OK);
    EXPECT(sectium_surface_evaluate_idle(&ctx, surf_bg, 6000u, 5000u, 15000u, &state) == B8G_DISPLAY_OK);
    EXPECT(state == B8G_SURFACE_IDLE);
    EXPECT(sectium_surface_evaluate_idle(&ctx, surf_bg, 20000u, 5000u, 15000u, &state) == B8G_DISPLAY_OK);
    EXPECT(state == B8G_SURFACE_FROZEN);
    /* Damage/commit blocked while FROZEN */
    EXPECT(sectium_surface_damage(&ctx, surf_bg, 0, 0, 16u, 16u) == B8G_DISPLAY_ERR_INVALID_STATE);
    EXPECT(sectium_surface_commit(&ctx, surf_bg, 21000u, NULL) == B8G_DISPLAY_ERR_INVALID_STATE);
    /* Next idle pass checkpoints frozen surface */
    EXPECT(sectium_surface_evaluate_idle(&ctx, surf_bg, 25000u, 5000u, 15000u, &state) == B8G_DISPLAY_OK);
    EXPECT(state == B8G_SURFACE_CHECKPOINTED);
    EXPECT(ctx.surfaces[1].checkpoint_epoch == 1u);

    /* Zero-copy thaw restores ACTIVE and preserves arena_offset */
    EXPECT(sectium_surface_thaw(&ctx, surf_bg, 26000u) == B8G_DISPLAY_OK);
    EXPECT(ctx.surfaces[1].state == B8G_SURFACE_ACTIVE);
    EXPECT(ctx.surfaces[1].arena_offset == bg_offset);
    EXPECT(sectium_surface_damage(&ctx, surf_bg, 0, 0, 64u, 64u) == B8G_DISPLAY_OK);
    EXPECT(sectium_surface_commit(&ctx, surf_bg, 26100u, &commit_seq) == B8G_DISPLAY_OK);
    EXPECT(commit_seq == 2u);

    /* 8. Zero-copy 2D <-> 3D compositor rebind */
    B8GWorldPose pose = { 1.5f, 2.0f, -3.5f, 0.0f, 0.7071f, 0.0f, 0.7071f, 1.25f };
    EXPECT(sectium_surface_rebind_mode(&ctx, surf_main, B8G_COMP_OPEN_WORLD_3D, &pose) == B8G_DISPLAY_OK);
    EXPECT(ctx.surfaces[0].compositor_mode == B8G_COMP_OPEN_WORLD_3D);
    EXPECT(ctx.surfaces[0].arena_offset == main_offset);
    EXPECT(ctx.surfaces[0].arena_size == main_size);
    EXPECT(ctx.surfaces[0].pose.pos_z == -3.5f);
    EXPECT(ctx.surfaces[0].rebind_count == 1u);

    /* Rebind back to 2D tiling, still zero-copy */
    EXPECT(sectium_surface_rebind_mode(&ctx, surf_main, B8G_COMP_TILING_2D, NULL) == B8G_DISPLAY_OK);
    EXPECT(ctx.surfaces[0].compositor_mode == B8G_COMP_TILING_2D);
    EXPECT(ctx.surfaces[0].arena_offset == main_offset);
    EXPECT(ctx.surfaces[0].rebind_count == 2u);

    /* Move surf_bg to 3D so stats verify both 2D and 3D counts */
    EXPECT(sectium_surface_rebind_mode(&ctx, surf_bg, B8G_COMP_OPEN_WORLD_3D, &pose) == B8G_DISPLAY_OK);

    /* 9. Verify aggregate stats */
    B8GDisplayStats stats;
    EXPECT(sectium_display_get_stats(&ctx, &stats) == B8G_DISPLAY_OK);
    EXPECT(stats.abi_magic == B8G_DISPLAY_MAGIC_V1);
    EXPECT(stats.abi_version == B8G_DISPLAY_ABI_VERSION);
    EXPECT(stats.active_actors == 3u);
    EXPECT(stats.active_surfaces == 2u);
    EXPECT(stats.active_bindings == 4u);
    EXPECT(stats.surfaces_active == 1u);
    EXPECT(stats.surfaces_display_sleep == 1u);
    EXPECT(stats.surfaces_2d == 1u);
    EXPECT(stats.surfaces_3d == 1u);
    EXPECT(stats.total_commits == 3u);
    EXPECT(stats.total_damage_rects == 3u);
    EXPECT(stats.total_rebinds == 3u);
    EXPECT(stats.total_checkpoints == 1u);

    printf("sectium_display_test: PASS (%u assertions)\n", g_assertions);
    return 0;
}
