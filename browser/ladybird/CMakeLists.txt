# Awesome-OS B8G_ABI_MAGIC_V3 C11 Accelerator Bridges for Ladybird
# Wires Media/Codec (Vulkan Video/VAAPI/NVDEC/VideoToolbox), WebGPU/Dawn, and
# V8/WASI zero-copy arena bridges directly into Ladybird's CMake/Ninja build.

add_library(b8g_ladybird_bridges STATIC
    b8g_ladybird_bridges.c
)

set_target_properties(b8g_ladybird_bridges PROPERTIES
    C_STANDARD 11
    C_STANDARD_REQUIRED ON
    POSITION_INDEPENDENT_CODE ON
)

target_include_directories(b8g_ladybird_bridges PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}"
)

if (CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(b8g_ladybird_bridges PRIVATE -Wall -Wextra)
endif()

if (BUILD_TESTING)
    add_executable(b8g_ladybird_bridge_test
        bridge_test.c
    )
    set_target_properties(b8g_ladybird_bridge_test PROPERTIES
        C_STANDARD 11
        C_STANDARD_REQUIRED ON
    )
    target_link_libraries(b8g_ladybird_bridge_test PRIVATE b8g_ladybird_bridges)
    add_test(NAME b8g_ladybird_bridge_test COMMAND b8g_ladybird_bridge_test)
endif()
