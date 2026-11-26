# Awesome-OS Deployment (`awesome-os/deployment`)

Centralized, pinned, declarative multi-domain deployment & health-check controller for Awesome-OS web portals, netboot endpoints, and `v11` CAS mirrors.

## Target Audience Domain Map

| Domain | Target Audience | Role |
| :--- | :--- | :--- |
| **[`b8g.dev`](https://b8g.dev/) & [`b8g.dev/awesome-os/`](https://b8g.dev/awesome-os/)** | Developers & Systems Engineers | `holo-compiler`, `t2linux-baseline`, EmuKit, Host Manager CLI/API, GitLab Holo Forge, architecture docs |
| **[`b8g.app`](https://b8g.app/)** | End-Users → Power-Users | Workstation Hub (**Omarchy**, **Noctalia**, **ChonkStep**, **Sectium**, **GNOME**, **KDE**), Sectium Browser, Code-OSS, OBS Vertical, White Dragon VTuber Studio |
| **[`awesome-os.com`](https://awesome-os.com/) & [`/cloud/`](https://awesome-os.com/cloud/)** | Enterprise & Cloud Buyers | Sovereign Enterprise OS presentation, `/cloud/` commercial offers, interactive fleet ROI calculator, iPXE netboot |

## Usage

```powershell
# Verify HTTP 200 health across all 3 domains
node deploy.mts --verify

# Preview pinned SHA-256 deployment plan
node deploy.mts --dry-run

# Deploy all pinned assets and run live verification
node deploy.mts --apply
```
