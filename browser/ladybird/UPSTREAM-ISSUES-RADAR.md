# AwesomeOS Ladybird — Live Upstream Issue Radar (`LadybirdBrowser/ladybird`)

> Tracks the **13** most active open upstream issues by comment volume — **7** already fixed or accelerated directly inside `awesome-os/ladybird`.

| Issue | Comments | Title | AwesomeOS Status | Resolution / Bridge |
| :--- | ---: | :--- | :--- | :--- |
| [#7025](https://github.com/LadybirdBrowser/ladybird/issues/7025) | 53 | FlyFF Universe crashes Ladybird | `TRACKED_UPSTREAM` | Monitored in AwesomeOS upstream radar |
| [#7461](https://github.com/LadybirdBrowser/ladybird/issues/7461) | 32 | VERIFICATION FAILED: m_impl->egl_image != EGL_NO_IMAGE on several websites | `FIXED_IN_FORK` | Services/Compositor/OpenGLContext.cpp: null-guarded DMABUF ext procs + RGBA8888 fallback + CPU surface fallback on EGL_NO_IMAGE |
| [#3438](https://github.com/LadybirdBrowser/ladybird/issues/3438) | 30 | Crash in Unicode::verify_icu_success with ICU error: U_MISSING_RESOURCE_ERROR | `FIXED_IN_FORK` | Libraries/LibUnicode/ICU.h: downgraded U_MISSING_RESOURCE_ERROR from fatal VERIFY_NOT_REACHED() abort to root-locale fallback warning |
| [#5030](https://github.com/LadybirdBrowser/ladybird/issues/5030) | 27 | Parts of Modrinth are not rendered correctly | `TRACKED_UPSTREAM` | Monitored in AwesomeOS upstream radar |
| [#6922](https://github.com/LadybirdBrowser/ladybird/issues/6922) | 20 | WebGL crash on Linux | `FIXED_IN_FORK` | Services/Compositor/OpenGLContext.cpp: fixed null pointer dereference when EGL_EXT_image_dma_buf_import_modifiers is absent on Linux drivers |
| [#976](https://github.com/LadybirdBrowser/ladybird/issues/976) | 20 | uBlock origin in ladybird | `FIXED_IN_FORK` | Bridges/AwesomeOS (B8gContentBlocker) + Extensions/WebExtensionsMV3.h: native uBlock/EasyList ||domain^ network blocker |
| [#38](https://github.com/LadybirdBrowser/ladybird/issues/38) | 20 | Windows support | `ACCELERATED_VIA_HOLO_V11` | Portable C11/C++23 Bridges + Holo v11 CAS hardlinks compile natively on Windows 11 with zig cc / clang without MSVC ABI mismatch |
| [#5107](https://github.com/LadybirdBrowser/ladybird/issues/5107) | 18 | Support dns HTTPS records | `FIXED_IN_FORK` | Bridges/AwesomeOS (b8g_dns_parse_https_rdata): RFC 9460 DNS TYPE 65 HTTPS/SVCB parser extracting h3/h2 ALPN, port, and ECH |
| [#7640](https://github.com/LadybirdBrowser/ladybird/issues/7640) | 17 | Turning off monitor causes ladybird segfault on Cosmic DE (root cause in Qt; fixed in Qt 6.10.3/6.11.1) | `TRACKED_UPSTREAM` | Monitored in AwesomeOS upstream radar |
| [#7752](https://github.com/LadybirdBrowser/ladybird/issues/7752) | 16 | Scripting crash on neetprep website | `TRACKED_UPSTREAM` | Monitored in AwesomeOS upstream radar |
| [#356](https://github.com/LadybirdBrowser/ladybird/issues/356) | 15 | Simple Page with 5 absolutely positioned transformed elements and drawing SVG Overlays does not work | `TRACKED_UPSTREAM` | Monitored in AwesomeOS upstream radar |
| [#3836](https://github.com/LadybirdBrowser/ladybird/issues/3836) | 14 | Ladybird partially uses system icu | `ACCELERATED_VIA_HOLO_V11` | Meta/CMake/holo_v11_toolchain.cmake: prepends hermetic $B8G_CAS_DIR/v11/links ICU so partial system ICU never collides |
| [#2774](https://github.com/LadybirdBrowser/ladybird/issues/2774) | 14 | Support android | `TRACKED_UPSTREAM` | Monitored in AwesomeOS upstream radar |
