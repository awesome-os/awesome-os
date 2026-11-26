# Awesome-OS Ladybird Hard-Fork — Chrome Feature-Parity & Gap Analysis

> Automated real-codebase audit of **`awesome-os/ladybird`** (BSD-2-Clause independent web engine, zero Blink/Gecko/WebKit) scanned in **5829 ms**.

## 1. Real Codebase Telemetry

- **Libraries Scanned:** `42` (`LibWeb`, `LibJS`, `LibGfx`, `LibWasm`, `LibMedia`, `LibHTTP`, `LibTLS`, `LibDevTools`, …)
- **WebIDL Interfaces (`.idl`):** `775`
- **Open `FIXME` Markers in `Libraries/`:** `1.348` (`TODO`: `30`)
- **LibJS JIT Files Present:** `true` (note: upstream Ladybird currently focuses on bytecode VM — Tier-2 JIT is a major Chrome speed gap)
- **LibWasm SIMD Files Present:** `true`
- **LibDevTools Present:** `true`
- **WebExtensions Engine Present:** `true`

### Top Libraries by Size & `FIXME` Density

| Library | Total Files | C++/H | WebIDL | `FIXME` Count |
| :--- | ---: | ---: | ---: | ---: |
| `LibWeb` | 3954 | 2041 | 775 | 1135 |
| `LibJS` | 860 | 157 | 0 | 1 |
| `LibWebCommon` | 270 | 240 | 0 | 30 |
| `LibWebView` | 253 | 246 | 0 | 52 |
| `LibWasm` | 217 | 4 | 0 | 0 |
| `LibMedia` | 193 | 190 | 0 | 20 |
| `LibGfx` | 185 | 149 | 0 | 9 |
| `LibCore` | 137 | 132 | 0 | 25 |
| `LibCompositing` | 128 | 34 | 0 | 0 |
| `LibMediaCodecs` | 97 | 93 | 0 | 1 |
| `LibDevTools` | 92 | 90 | 0 | 39 |
| `LibGC` | 76 | 60 | 0 | 0 |
| `LibIPC` | 76 | 56 | 0 | 2 |
| `LibUnicode` | 67 | 59 | 0 | 1 |
| `LibURL` | 51 | 17 | 0 | 2 |

## 2. Chrome Feature-Parity Matrix (18 Active/Partial · 0 Early Stub · 0 Missing)

| Feature Area | Chrome Baseline | Status | `.idl` Count | Awesome-OS Accelerator |
| :--- | :--- | :--- | ---: | :--- |
| **Graphics** (`webgpu`) | WebGPU + WGSL (Dawn) | `implemented-or-partial` | 8 | Plug in awesome-os/sectium holo-display-webgpu + Dawn v11 CAS |
| **Graphics** (`webgl`) | WebGL 1 & WebGL 2 | `implemented-or-partial` | 27 | ANGLE / Dawn WebGL-on-WebGPU backend |
| **PWA / Offline** (`service-worker`) | ServiceWorker + FetchEvent + Clients | `implemented-or-partial` | 6 | Direct OPFS v11 CAS ServiceWorker runtime (holo-web-service-worker) |
| **Storage** (`opfs`) | Origin Private File System (FileSystemSyncAccessHandle) | `implemented-or-partial` | 5 | Map directly to B8G v11 CAS /var/lib/b8g/cas/v11/files/ |
| **Storage** (`indexeddb`) | IndexedDB v3 (async transactions) | `implemented-or-partial` | 12 | B8G CAS B-Tree / SQLite-free mmap store |
| **Real-Time** (`webrtc`) | RTCPeerConnection + DataChannel + MediaStream | `implemented-or-partial` | 27 | mTLS + B8G_ARENA_V1 zero-copy peer transport |
| **Media** (`webcodecs`) | WebCodecs (VideoDecoder / AudioDecoder / Hardware) | `implemented-or-partial` | 4 | Generic Vulkan Video / VAAPI / NVDEC / VideoToolbox bridge (modalias v11 CAS) |
| **Media** (`mse`) | MediaSource Extensions (YouTube / Twitch) | `implemented-or-partial` | 3 | Shared LibMedia + hardware H.264/AV1/VP9 pipeline |
| **Audio** (`webaudio`) | WebAudio API (AudioWorklet + Nodes) | `implemented-or-partial` | 8 | Low-latency B8G ring audio worklet |
| **Networking** (`webtransport`) | WebTransport (HTTP/3 QUIC) | `implemented-or-partial` | 3 | QUIC/HTTP3 via LibHTTP + B8G transport |
| **Networking** (`websockets`) | WebSocket + WebSocketStream | `implemented-or-partial` | 3 | Native LibWebSocket (already present) |
| **DOM / UI** (`webcomponents`) | CustomElements + ShadowDOM + Declarative Shadow DOM | `implemented-or-partial` | 3 | First-class <b8g-*> HTML5 Web Components |
| **Streams** (`streams`) | WHATWG Readable/Writable/TransformStream | `implemented-or-partial` | 11 | 7-Tuple Web Streams zero-copy pipe |
| **Concurrency** (`workers`) | Dedicated/SharedWorker + BroadcastChannel | `implemented-or-partial` | 3 | SharedArrayBuffer B8G_ARENA_V1 workers |
| **Security** (`webauthn`) | WebAuthn / Passkeys + WebCrypto | `implemented-or-partial` | 3 | Ed25519 / FIDO2 hardware key bridge |
| **Hardware** (`webhid-usb`) | WebHID / WebUSB / WebSerial / Gamepad | `implemented-or-partial` | 4 | holo-device-host + modalias v11 CAS device bridge |
| **Desktop** (`clipboard`) | Async Clipboard API + Drag & Drop | `implemented-or-partial` | 6 | Wayland wl_data_device / Win32 pipe bridge |
| **Platform** (`permissions`) | Permissions + Notifications + Push API | `implemented-or-partial` | 3 | host-manager declarative ChromeOS policy engine |

## 3. What Is Actually Missing to Match Chrome (Ranked by Impact)

1. **JS Engine Peak Performance (Tier-2 Optimizing JIT):** `LibJS` has high ECMAScript spec conformance via its bytecode VM, but lacks a V8 TurboFan/Maglev-class optimizing JIT. *(Awesome-OS bridge: `holo-compiler` native codegen + `sectium-es`)*
2. **PWA / Service Workers & OPFS (`ServiceWorker`, `CacheStorage`, `FileSystemSyncAccessHandle`):** Essential for offline web apps and our `holo-web-service-worker.js`. *(Awesome-OS bridge: mount `v11` CAS directly as OPFS)*
3. **GPU Compute & 3D (`WebGPU` + `WebGL 1/2`):** Critical for Three.js, Figma, games, and our White Dragon VTuber Studio. *(Awesome-OS bridge: `holo-display-webgpu` + Dawn)*
4. **Real-Time & Hardware Media (`WebRTC`, `WebCodecs`, `MSE`):** Required for Google Meet, Discord, Twitch, YouTube 4K60, and OBS browser sources.
5. **Multi-Process Site Isolation & OS Sandboxing:** Chrome isolates every origin into a strict OS sandbox (`AppContainer` on Windows, `seccomp-bpf` + namespaces on Linux). *(Awesome-OS bridge: `Sectium` AppContainer + `B8G_ARENA_V1` pipe IPC)*
6. **WebExtensions (MV3) & Full Chrome DevTools Protocol (CDP):** Required for developer workflows and password managers. *(Awesome-OS bridge: `SectiumDevToolsPlane` over `channel: command`)*
