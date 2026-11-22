# Formal Security & Quaternion Invariants Statement

> **Status:** Audit-Grade Formal Specification (grounded in live workspace implementations)
> **Scope:** `sections/manifold/b8g-kernel-engine.mts`, `sections/ephemeral-token/index.mts`, `sections/chromium-build/inmem-linker/b8g_origin_linker.h`, and `B8G-ABI v2 -> v3` C-ABI contracts.
> **Machine-Checkable Verification:** [`sections/manifold/quaternion-security-invariants.test.mts`](file:///e:/awesome-os/sections/manifold/quaternion-security-invariants.test.mts)

---

## Executive Summary & Trust Boundary

This document establishes four formal invariants governing mathematical state-space evolution, capability confinement, executable memory isolation, and binary ABI compatibility across Awesome-OS:

| # | Domain | Core Invariant | Primary Implementation |
| :- | :--- | :--- | :--- |
| **1** | **$S^3$ Unit-Quaternion Algebra** | $\|q\| = 1$, $q^{-1} = q^*$, exact rollback $q^*(q v q^*)q = v$ | [`sections/manifold/b8g-kernel-engine.mts`](file:///e:/awesome-os/sections/manifold/b8g-kernel-engine.mts) |
| **2** | **Ephemeral Capability Lattice** | $C_{\text{child}} \le C_{\text{parent}}$, RAM-only lease, `fill(0)` + `revoke()` on `dispose()` | [`sections/ephemeral-token/index.mts`](file:///e:/awesome-os/sections/ephemeral-token/index.mts) |
| **3** | **Strict `W^X` & `O(1)` Origin Arena** | $\forall i,p:\ \neg(\text{Write}(p,i) \land \text{Exec}(p,i))$, `0xCC` guards, atomic `VirtualFree`/`munmap` | [`sections/chromium-build/inmem-linker/b8g_origin_linker.h`](file:///e:/awesome-os/sections/chromium-build/inmem-linker/b8g_origin_linker.h) |
| **4** | **`B8G-ABI v2 -> v3` Prefix Contract** | `_Static_assert(offsetof(V3, base) == 0)` + runtime `struct_size` bounds check | [`packages/@awesome-os/b8g/b8g-abi/b8g_abi.h`](file:///e:/awesome-os/packages/@awesome-os/b8g/b8g-abi/b8g_abi.h), [`b8g_origin_linker.h`](file:///e:/awesome-os/sections/chromium-build/inmem-linker/b8g_origin_linker.h) |

---

## Section 1: Algebraic $S^3$ Unit-Quaternion State & Conjugation Rollback Formalism

### 1.1 Mathematical Definition

Let $\mathbb{H} = \{ w + xi + yj + zk \mid w, x, y, z \in \mathbb{R} \}$ be the division ring of Hamilton quaternions with basis relations:

$$i^2 = j^2 = k^2 = ijk = -1.$$

For $q = w + xi + yj + zk \in \mathbb{H}$, define:

- **Euclidean Norm:** $\|q\| = \sqrt{w^2 + x^2 + y^2 + z^2}$.
- **Conjugate:** $q^* = w - xi - yj - zk$.
- **Unit 3-Sphere Group:** $S^3 = \{ q \in \mathbb{H} \mid \|q\| = 1 \} \cong \mathrm{SU}(2)$.

For every $q \in S^3$:

$$q q^* = q^* q = \|q\|^2 = 1 \implies q^{-1} = q^*.$$

Embed any 3D vector $\vec{v} = (v_x, v_y, v_z) \in \mathbb{R}^3$ as a pure imaginary quaternion $v = 0 + v_x i + v_y j + v_z k \in \operatorname{Im}(\mathbb{H})$. The adjoint (conjugation) action of $q \in S^3$ on $\operatorname{Im}(\mathbb{H})$ is:

$$v' = \Phi_q(v) = q v q^*.$$

The map $\pi: S^3 \to \mathrm{SO}(3)$ defined by $\pi(q) = \Phi_q$ is a surjective Lie group homomorphism with $\ker(\pi) = \{ +1, -1 \}$ (the spinor double cover of $\mathrm{SO}(3)$).

### 1.2 Exact Conjugation Rollback

Because $q^{-1} = q^*$ on $S^3$ and quaternion multiplication is associative, applying the conjugate action $\Phi_{q^*}$ to $v' = q v q^*$ yields exact algebraic rollback:

$$\Phi_{q^*}(v') = q^* v' q = q^* (q v q^*) q = (q^* q)\, v\, (q^* q) = 1 \cdot v \cdot 1 = v.$$

For a sequence of state-space orientation transitions $q_1, q_2, \dots, q_n \in S^3$ with composite rotor $Q = q_n \cdots q_2 q_1 \in S^3$, the exact inverse transition is $Q^* = q_1^* q_2^* \cdots q_n^*$, restoring $v = Q^* (Q v Q^*) Q$ in a single conjugation step.

### 1.3 Verified Mathematical Properties

In [`sections/manifold/b8g-kernel-engine.mts`](file:///e:/awesome-os/sections/manifold/b8g-kernel-engine.mts) (`UnitQuaternion`, lines 151–263; `B8GKernelArena.step`, lines 508–536):

1. **Norm Preservation (Closure on $S^3$):**
   - Analytically: $\|q_1 q_2\| = \|q_1\|\|q_2\| = 1$ and $\|q v q^*\| = \|q\|\|v\|\|q^*\| = \|v\|$.
   - Numerically: `UnitQuaternion` normalizes on construction (`normalize()`), and `B8GKernelArena.step()` re-projects every integrated rotor onto $S^3$ (`qw = nqw / rawNorm`, etc.), with `auditNormInvariants()` tracking $\max_i |\|q_i\| - 1|$ and emitting `TRAP_QUATERNION_NORM_DRIFT` if drift exceeds tolerance.
2. **Exact Invertibility (Conjugation Rollback):**
   - Given `v' = q.rotateVec3(vx, vy, vz)` and `qConj = new UnitQuaternion(q.w, -q.x, -q.y, -q.z)`, `v'' = qConj.rotateVec3(v'.x, v'.y, v'.z)` satisfies $\|v'' - v\|_2 < 10^{-12}$ under IEEE-754 `float64` arithmetic.
3. **Gimbal-Lock-Free Geodesic Interpolation (SLERP):**
   - `UnitQuaternion.slerp(target, t)` canonicalizes the antipodal hemisphere (`if (cosOmega < 0) negate target`) to guarantee shortest-arc geodesic interpolation on $S^3$, clamps `cosOmega` to $[-1, 1]$ to prevent `NaN`, falls back to normalized linear interpolation (NLERP) for $\cos\Omega > 0.9995$, and preserves unit norm across all $t \in [0, 1]$ with exact endpoints at $t = 0$ and $t = 1$.

### 1.4 Honest Security Boundary Note

> [!IMPORTANT]
> **Architectural Honesty Boundary:** `UnitQuaternion` on $S^3$ models **geometric and state-space orientation and algebraically reversible transitions** (specifically the nonholonomic multi-sphere rolling manifold $\mathrm{SO}(3) \times \mathbb{R}^2$ in [`sections/manifold/b8g-kernel-engine.mts`](file:///e:/awesome-os/sections/manifold/b8g-kernel-engine.mts)).
>
> Quaternion multiplication and conjugation are **not cryptographic primitives**: they are linear over $\mathbb{R}^4$, trivially invertible by any observer who knows $q$, and provide neither confidentiality, integrity authentication, nor memory isolation.
>
> **Cryptographic, capability, and memory-isolation guarantees** are enforced exclusively by the concrete runtime mechanisms formalized in **Sections 2–4** below—together with the branchless 64-bit constant-time capability gate (`B8GMemoryArena64.ctEq64` / `UniversalCapabilityGate`, lines 98–145 of `b8g-kernel-engine.mts`), which verifies `((capabilityToken & requiredMask) ^ requiredMask) == 0` without data-dependent branching.

---

## Section 2: Monotonic Capability Narrowing & Ephemeral Token Invariants

**Implementation:** [`sections/ephemeral-token/index.mts`](file:///e:/awesome-os/sections/ephemeral-token/index.mts)

### 2.1 Formal Capability Lattice & Monotonic Narrowing

Model the authority space as a bounded meet-semilattice $(\mathcal{C}, \le, \sqcap, \bot)$ where each capability $C = (\text{scope}, [t_{\text{issue}}, t_{\text{exp}}], \text{state})$ carries a scope set, a finite validity interval, and a lifecycle state $\text{state} \in \{\text{ACTIVE}, \text{REVOKED}\}$, with $\bot$ denoting the revoked / zero-authority element.

- **Partial Order ($\le$):** $C_{\text{child}} \le C_{\text{parent}}$ iff:
  1. $\text{scope}(C_{\text{child}}) \subseteq \text{scope}(C_{\text{parent}})$,
  2. $[t_{\text{issue}}(C_{\text{child}}), t_{\text{exp}}(C_{\text{child}})] \subseteq [t_{\text{issue}}(C_{\text{parent}}), t_{\text{exp}}(C_{\text{parent}})]$, and
  3. $\text{state}(C_{\text{parent}}) = \text{REVOKED} \implies \text{state}(C_{\text{child}}) = \text{REVOKED}$ (i.e., $C_{\text{child}} = \bot$).
- **Monotonic Attenuation Invariant:** Every delegation or sub-lease derivation applies $C_{\text{child}} = C_{\text{parent}} \sqcap C_{\text{req}} \le C_{\text{parent}}$. No operation in the capability API can synthesize a capability $C'$ with $C' \not\le C_{\text{parent}}$.

### 2.2 RAM-Only Lease Lifecycle

`EphemeralCapabilityIntersection` replaces static long-lived secrets with short-lived, scope-bound leases held exclusively in process RAM:

1. **Acquisition (`acquire()`):** Mints a scoped lease via `provider.mint(this.scope, this.ttlMs)` (minimum `ttlMs` clamped to `50` ms). Stores secret bytes in a private `Buffer` (`this.secretBuf`) and schedules an unref'd auto-refresh timer at $60\%$ of TTL (`Math.max(25, Math.floor(ttlMs * 0.6))`). Rejects immediately with `CapabilityRevokedError` (`ERR_CAPABILITY_REVOKED`) if `this.revoked === true`.
2. **Scoped Use (`withSecret(fn)`):** Checks `!this.revoked && this.secretBuf && this.lease`. If `Date.now() > this.lease.expiresAtMs`, attempts a synchronous-await `tryRefresh()`; if refresh fails or the lease remains expired/revoked, it **fails closed** by throwing `CapabilityRevokedError`.
3. **Refresh Hygiene (`storeSecret()`):** Before replacing `this.secretBuf` on refresh, overwrites the previous buffer in-place via `this.secretBuf.fill(0)`.
4. **Automatic Log Redaction (`redact(text)`):** Replaces every occurrence of the active secret (length $\ge 4$) in outbound logs/strings with `***EPHEMERAL_REDACTED***`.

### 2.3 Deterministic Disposal (`fill(0)` + `provider.revoke()`)

`EphemeralCapabilityIntersection.dispose()` (lines 120–136) enforces an irreversible transition to $\bot$:

1. **Idempotent Lockout:** `if (this.revoked) return; this.revoked = true;` — immediately blocks concurrent `acquire()`, `tryRefresh()`, and `withSecret()` calls.
2. **Timer Teardown:** `clearInterval(this.refreshTimer); this.refreshTimer = null;` — halts any future background refresh.
3. **In-Place Memory Zeroing:** `this.secretBuf.fill(0); this.secretBuf = null;` — deterministically overwrites every byte of the backing `Buffer` with `0x00` before releasing the reference.
4. **Upstream Revocation:** Detaches `this.lease = null` and awaits `this.provider.revoke(oldLease)` so the remote/local issuer invalidates the token immediately.

### 2.4 Proof Sketch of Non-Escalation & Post-Disposal Unreachability

- **Theorem (Non-Escalation):** Given a parent intersection bound to `scope` and monotonic derivation $C_{\text{child}} \le C_{\text{parent}}$, no call sequence on `EphemeralCapabilityIntersection` can widen `this.scope` (declared `private readonly`), extend authority past `dispose()`, or recover a secret after `dispose()`.
- **Proof Sketch:**
  1. `scope` is immutable (`private readonly`) after construction; `acquire()` and `tryRefresh()` only request `this.scope`.
  2. `revoked` transitions monotonically $\text{false} \to \text{true}$ and has no reset path.
  3. On `dispose()`, `revoked` is set to `true` **before** any `await` (`provider.revoke`), eliminating TOCTOU re-entry windows during async revocation. Both `acquire()` and `withSecret()` check `this.revoked` as their first guard and throw `CapabilityRevokedError`.
  4. `secretBuf.fill(0)` zeroes the mutable backing store prior to dereferencing, ensuring residual heap inspection of the `Buffer` yields only `0x00` bytes.
- **Audit Caveat (JS Runtime Boundary):** Because JavaScript `string` values passed to `withSecret(fn)` callbacks are immutable and GC-managed by V8, `fill(0)` deterministically zeroes the `Buffer` backing store but cannot forcibly zero transient JS `string` copies inside user callbacks. Callers MUST NOT copy or cache the `secret` argument outside `withSecret`.

---

## Section 3: Strict `W^X` (`RW -> RX`) In-Memory Linking & `O(1)` Origin Disposal

**Implementation:** [`sections/chromium-build/inmem-linker/b8g_origin_linker.h`](file:///e:/awesome-os/sections/chromium-build/inmem-linker/b8g_origin_linker.h) and [`sections/chromium-build/inmem-linker/b8g_inmem_linker_bench.cc`](file:///e:/awesome-os/sections/chromium-build/inmem-linker/b8g_inmem_linker_bench.cc)

### 3.1 Strict `W^X` Invariant

For every virtual memory page $p$ owned by a `B8gOriginArena` and every CPU instruction retirement point $i$:

$$\forall p, \forall i:\quad \neg\big(\text{Write}(p, i) \land \text{Exec}(p, i)\big).$$

No page in `B8gOriginArena` is ever allocated or protected with `PAGE_EXECUTE_READWRITE` (`RWX`).

### 3.2 `RW -> RX` Trampoline Emission & `0xCC` Slot Guards

In `B8gOriginArena::InstallWxTrampoline(uint32_t slot, void* target_fn)` (lines 164–192):

1. **Initial Allocation (`RW` only):** Allocates one 4096-byte per-origin `wx_trampoline_page` via `VirtualAlloc(..., PAGE_READWRITE)`.
2. **Slot Layout (16-byte stride, up to `B8G_DEP_MAX = 32` slots):**
   - Transitions page protection to `PAGE_READWRITE`.
   - Writes the 12-byte x86-64 direct jump stub at `wx_trampoline_page + slot * 16`:
     - `code[0..1] = 0x48, 0xB8` (`movabs rax, imm64`)
     - `code[2..9] = <uint64_t target_fn>`
     - `code[10..11] = 0xFF, 0xE0` (`jmp rax`)
   - Writes **4 bytes of `0xCC` (`INT3` software breakpoint trap)** into `code[12..15]` as hardware-enforced slot guards. Any miscalculated jump offset or linear fallthrough past a stub traps immediately instead of sliding into the next dependency slot.
3. **Finalization (`RX` only + I-Cache Coherence):**
   - Transitions page protection to `PAGE_EXECUTE_READ` (`RX`) via `VirtualProtect`.
   - Calls `FlushInstructionCache(GetCurrentProcess(), code, 16)` before returning the callable function pointer.
4. **Data Arena Isolation:** `B8gOriginArena::base` (`B8G_ARENA_V1`) is allocated strictly `PAGE_READWRITE` (`PROT_READ | PROT_WRITE` on POSIX) and is never transitioned to executable.

> [!NOTE]
> **Platform & Concurrency Audit Notes:**
> - **Single-Writer Patching:** On Windows, `InstallWxTrampoline` toggles the per-origin trampoline page `RX -> RW -> RX` while installing a new lazy slot. Lazy loading on an origin MUST be serialized with respect to calls through previously installed slots on that same origin.
> - **POSIX Path:** On non-Windows builds (`#else` branch, line 190), `InstallWxTrampoline` currently returns `reinterpret_cast<RawFn>(target_fn)` directly without allocating a separate trampoline page (preserving `W^X` by avoiding any writable code page).

### 3.3 `O(1)` Atomic Origin Disposal & Zero-Persistence Proof

Every origin binds its dependency allocations to a per-origin bump allocator (`AllocCb` / `FreeCb` no-op, lines 114–138) backed by `B8gOriginArena::base`. Individual frees are `O(1)` no-ops; cross-origin heap reuse is structurally impossible because no two origins share a backing region.

On tab/context teardown or cross-origin navigation, `B8gOriginArena::Dispose()` (lines 234–270):

1. Invokes each loaded module's `dep_disposers[i](dep_states[i])` and unloads module handles (`FreeLibrary` / `dlclose`).
2. Atomically releases `wx_trampoline_page` via `VirtualFree(wx_trampoline_page, 0, MEM_RELEASE)` (Windows).
3. Atomically unmaps the entire data arena `base` via `VirtualFree(base, 0, MEM_RELEASE)` (Windows) or `munmap(base, capacity)` (POSIX).
4. Resets `loaded_mask = 0`, `loaded_count = 0`, `capacity = 0`, `offset = 0`.

**Empirical Stress Verification:** [`sections/chromium-build/inmem-linker/b8g_inmem_linker_bench.cc`](file:///e:/awesome-os/sections/chromium-build/inmem-linker/b8g_inmem_linker_bench.cc) (lines 115–129) executes **100 consecutive full origin lifecycles** (`Init(id, 1 MiB)` $\to$ `64 KiB` arena allocation + `memset` $\to$ `O(1) Dispose()`), verifying complete reclamation with **`0` leaked bytes** across all 100 tab lifecycles.

---

## Section 4: Step-Wise `B8G-ABI v2 -> v3` Binary Prefix Invariant

### 4.1 ABI Lineage

- **`B8G Component ABI v2`:** [`packages/@awesome-os/b8g/b8g-abi/b8g_abi.h`](file:///e:/awesome-os/packages/@awesome-os/b8g/b8g-abi/b8g_abi.h) (`COMPONENT_API_VERSION 2`, `component_api_t`) and [`sections/b8g-abi-v8/b8g_abi_v8_section.h`](file:///e:/awesome-os/sections/b8g-abi-v8/b8g_abi_v8_section.h) (`B8G_V8_SECTION_ABI_VERSION 2u`).
- **`B8G-ABI v3` (Origin-Scoped Dependency Contract):** [`sections/chromium-build/inmem-linker/b8g_origin_linker.h`](file:///e:/awesome-os/sections/chromium-build/inmem-linker/b8g_origin_linker.h) (`B8G_DEP_ABI_VERSION 3u`, `B8gDepModuleV3`).

### 4.2 Formal Binary Prefix & `struct_size` Bounds Contract

To guarantee zero-UB, step-wise ABI evolution across independently compiled C, C++, Zig, and Rust modules without recompiling the entire dependency graph, any versioned ABI extension $S_{v+1}$ that extends $S_v$ MUST satisfy two invariants:

1. **Compile-Time Prefix Identity (`_Static_assert`):**
   Embed the previous ABI version as the first member (`base`) at byte offset `0`, and enforce it at compile time:

   ```c
   typedef struct B8gAbiV3Extended {
     B8gAbiV2Base base;         // MUST remain at offset 0
     uint32_t     struct_size;  // sizeof(B8gAbiV3Extended) set by producer
     uint32_t     abi_version;  // >= 3u
     /* ... v3-only trailing fields ... */
   } B8gAbiV3Extended;

   _Static_assert(offsetof(B8gAbiV3Extended, base) == 0,
                  "B8G-ABI v3 must preserve v2 binary prefix at offset 0");
   _Static_assert(sizeof(B8gAbiV3Extended) >= sizeof(B8gAbiV2Base),
                  "B8G-ABI v3 struct cannot shrink below v2 prefix");
   ```

   Because `offsetof(S_{v+1}, base) == 0`, any pointer `const S_{v+1}*` is strictly layout-compatible with `const S_v*` under ISO C11 §6.7.2.1p15 ("a pointer to a structure object, suitably converted, points to its initial member").

2. **Runtime `struct_size` Bounds Check (Fail-Closed):**
   Before any consumer dereferences an extended field `f` introduced in ABI version $v+1$, it MUST verify:

   ```c
   #define B8G_ABI_HAS_FIELD(ptr, Type, field) \
     ((ptr) != NULL && \
      (ptr)->struct_size >= (offsetof(Type, field) + sizeof(((const Type*)0)->field)))
   ```

   If `abi_version` is unsupported or `B8G_ABI_HAS_FIELD` evaluates to false, the loader **fails closed** (returns `NULL` / error code) and never reads past the caller-allocated descriptor boundary.

### 4.3 Current Implementation Status Note

In [`b8g_origin_linker.h`](file:///e:/awesome-os/sections/chromium-build/inmem-linker/b8g_origin_linker.h) (`B8gDepModuleV3`, lines 55–63), the origin-scoped dependency descriptor is currently a standalone v3 struct validated by exact version equality (`mod->abi_version != B8G_DEP_ABI_VERSION`, checked in [`b8g_18_dep_origin_proof.cc`](file:///e:/awesome-os/sections/chromium-build/inmem-linker/b8g_18_dep_origin_proof.cc#L68-L69)). Any future v3 $\to$ v4 extension or v2-bridged descriptor MUST adopt the `_Static_assert(offsetof == 0)` prefix layout and `struct_size` bounds check above.

---

## Section 5: Verification Matrix

| Invariant | Verification Artifact | Command |
| :--- | :--- | :--- |
| $S^3$ unit norm, conjugation rollback ($\|q^*(qvq^*)q - v\| < 10^{-12}$), SLERP endpoints | [`quaternion-security-invariants.test.mts`](file:///e:/awesome-os/sections/manifold/quaternion-security-invariants.test.mts) | `.\bin\node.ps1 --test sections/manifold/quaternion-security-invariants.test.mts` |
| Ephemeral token redaction, `fill(0)` zero-wipe, `provider.revoke()`, fail-closed post-dispose | [`quaternion-security-invariants.test.mts`](file:///e:/awesome-os/sections/manifold/quaternion-security-invariants.test.mts) | `.\bin\node.ps1 --test sections/manifold/quaternion-security-invariants.test.mts` |
| `W^X` `RW -> RX` trampoline & 100-tab `O(1)` `VirtualFree` (`0` leaked bytes) | [`b8g_inmem_linker_bench.cc`](file:///e:/awesome-os/sections/chromium-build/inmem-linker/b8g_inmem_linker_bench.cc) | Native C++ benchmark target |
| 18-target `B8G-ABI v3` version-checked origin linking & disposal | [`b8g_18_dep_origin_proof.cc`](file:///e:/awesome-os/sections/chromium-build/inmem-linker/b8g_18_dep_origin_proof.cc) | Native C++ proof target |
