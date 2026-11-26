# Changelog

All notable changes to `awesome-os/awesome-os` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Canonical verbatim SPDX `LICENSE` for deterministic GitHub Licensee detection.
- `.gitattributes` enforcing consistent LF/CRLF and binary handling across Windows and POSIX.
- `.github/CODEOWNERS` governance and workflow ownership rules.
- `CHANGELOG.md` initialized in Keep a Changelog v1.1.0 format for release traceability.

## [11.0.0] - 2026-11-26

### Changed
- Sovereign OS monorepo aligned on Holo v11 CAS (`B8G_ABI_MAGIC_V3 = 0x33564742`) with `holo-distro-bootstrap`, `holo-upgrade`, Limine/UEFI GOP splash, Holo-Linux `7.3.6`, and freestanding Zig microkernel.
- Added zero-telemetry Firefox `24/24` CAS profile, rootless `apt-dpkg-projector`, Sectium + Ladybird browser integration, and Holo-E2E Lavapipe Zero-X11 verification workflow.
