/**
 * @file local-cpp/vdm_local.cpp
 * @description Tiny zero-dependency C++20 Win64/POSIX CLI that cleanly manages ONLY
 * fenced `# BEGIN AWESOME-OS VDM` ... `# END AWESOME-OS VDM` blocks inside:
 *   1. C:\Windows\System32\drivers\etc\hosts  (or /etc/hosts)
 *   2. %USERPROFILE%\.ssh\config              (or ~/.ssh/config)
 *
 * Reads hosts directly from virtual-domains.json.
 * Safe by default (--dry-run); pass --apply to write atomically with .vdm.bak backup.
 */

#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

static const std::string kBeginMarker = "# BEGIN AWESOME-OS VDM";
static const std::string kEndMarker = "# END AWESOME-OS VDM";

struct Options {
  std::string cmd = "sync";
  std::string configPath = "virtual-domains.json";
  std::string ip = "127.0.0.1";
  std::string sshHost = "mail.dspeed.eu";
  std::string sshUser = "ubuntu";
  std::string hostsFile;
  std::string sshConfigFile;
  bool apply = false;
};

static std::string defaultHostsPath() {
#ifdef _WIN32
  return "C:\\Windows\\System32\\drivers\\etc\\hosts";
#else
  return "/etc/hosts";
#endif
}

static std::string defaultSshConfigPath() {
#ifdef _WIN32
  const char* profile = std::getenv("USERPROFILE");
  return (fs::path(profile ? profile : ".") / ".ssh" / "config").string();
#else
  const char* home = std::getenv("HOME");
  return (fs::path(home ? home : ".") / ".ssh" / "config").string();
#endif
}

static std::string readFileText(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  if (!in) return "";
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

static std::vector<std::string> extractHostsFromJson(const std::string& jsonText) {
  std::set<std::string> unique;
  std::regex re(R"re("host"\s*:\s*"([A-Za-z0-9._-]+)")re");
  auto begin = std::sregex_iterator(jsonText.begin(), jsonText.end(), re);
  auto end = std::sregex_iterator();
  for (auto it = begin; it != end; ++it) {
    unique.insert((*it)[1].str());
  }
  return std::vector<std::string>(unique.begin(), unique.end());
}

static std::string stripFencedBlock(const std::string& original) {
  std::istringstream iss(original);
  std::ostringstream out;
  std::string line;
  bool inside = false;
  while (std::getline(iss, line)) {
    std::string clean = line;
    if (!clean.empty() && clean.back() == '\r') clean.pop_back();
    if (clean == kBeginMarker) {
      inside = true;
      continue;
    }
    if (clean == kEndMarker) {
      inside = false;
      continue;
    }
    if (!inside) {
      out << clean << "\n";
    }
  }
  return out.str();
}

static std::string buildHostsBlock(const std::vector<std::string>& hosts, const std::string& ip) {
  std::ostringstream ss;
  ss << kBeginMarker << "\n";
  for (const auto& h : hosts) {
    ss << ip << "  " << h << "\n";
  }
  ss << kEndMarker << "\n";
  return ss.str();
}

static std::string buildSshBlock(
    const std::vector<std::string>& hosts,
    const std::string& sshHost,
    const std::string& sshUser) {
  std::ostringstream ss;
  ss << kBeginMarker << "\n";
  for (const auto& h : hosts) {
    ss << "Host " << h << "\n";
    ss << "  HostName " << sshHost << "\n";
    ss << "  User " << sshUser << "\n";
    ss << "  ServerAliveInterval 30\n";
  }
  ss << kEndMarker << "\n";
  return ss.str();
}

static bool writeFencedFile(
    const fs::path& target,
    const std::string& newBlock,
    bool apply,
    const std::string& label) {
  const std::string existing = readFileText(target);
  std::string stripped = stripFencedBlock(existing);
  while (!stripped.empty() && stripped.back() == '\n') stripped.pop_back();

  std::string finalContent = stripped;
  if (!finalContent.empty()) finalContent += "\n\n";
  if (!newBlock.empty()) finalContent += newBlock;

  if (!apply) {
    std::cout << "=== [DRY-RUN] " << label << " (" << target.string() << ") ===\n";
    std::cout << (newBlock.empty() ? "(fenced Awesome-OS VDM block removed)\n" : newBlock);
    return true;
  }

  try {
    if (target.has_parent_path()) fs::create_directories(target.parent_path());
    if (fs::exists(target)) {
      fs::path bak = target;
      bak += ".vdm.bak";
      fs::copy_file(target, bak, fs::copy_options::overwrite_existing);
    }
    std::ofstream out(target, std::ios::binary | std::ios::trunc);
    if (!out) {
      std::cerr << "[ERROR] Cannot write " << target.string()
                << " (run an elevated Administrator shell for Windows etc\\hosts).\n";
      return false;
    }
    out << finalContent;
    out.close();
    std::cout << "[APPLIED] Updated fenced VDM block in " << target.string() << "\n";
    return true;
  } catch (const std::exception& ex) {
    std::cerr << "[ERROR] Failed writing " << target.string() << ": " << ex.what() << "\n";
    return false;
  }
}

static void printUsage() {
  std::cout << "vdm-local — Awesome-OS Local Virtual Domain Manager (C++20)\n\n"
            << "Usage:\n"
            << "  vdm-local sync  [--config virtual-domains.json] [--ip 127.0.0.1] [--ssh-host mail.dspeed.eu] [--ssh-user ubuntu] [--apply]\n"
            << "  vdm-local clean [--apply]\n"
            << "  vdm-local status [--hosts-file <path>] [--ssh-config <path>]\n\n"
            << "Safety: Runs in --dry-run mode by default. Pass --apply to write (.vdm.bak backup created).\n";
}

int main(int argc, char** argv) {
  Options opts;
  opts.hostsFile = defaultHostsPath();
  opts.sshConfigFile = defaultSshConfigPath();

  if (argc > 1) {
    std::string first = argv[1];
    if (first == "-h" || first == "--help" || first == "help") {
      printUsage();
      return 0;
    }
    if (!first.empty() && first[0] != '-') opts.cmd = first;
  }

  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--apply") opts.apply = true;
    else if (a == "--config" && i + 1 < argc) opts.configPath = argv[++i];
    else if (a == "--ip" && i + 1 < argc) opts.ip = argv[++i];
    else if (a == "--ssh-host" && i + 1 < argc) opts.sshHost = argv[++i];
    else if (a == "--ssh-user" && i + 1 < argc) opts.sshUser = argv[++i];
    else if (a == "--hosts-file" && i + 1 < argc) opts.hostsFile = argv[++i];
    else if (a == "--ssh-config" && i + 1 < argc) opts.sshConfigFile = argv[++i];
  }

  if (opts.cmd == "status") {
    const std::string hText = readFileText(opts.hostsFile);
    const std::string sText = readFileText(opts.sshConfigFile);
    std::cout << "hosts (" << opts.hostsFile << "): "
              << (hText.find(kBeginMarker) != std::string::npos ? "VDM ACTIVE" : "clean") << "\n";
    std::cout << "ssh   (" << opts.sshConfigFile << "): "
              << (sText.find(kBeginMarker) != std::string::npos ? "VDM ACTIVE" : "clean") << "\n";
    return 0;
  }

  if (opts.cmd == "clean") {
    bool ok1 = writeFencedFile(opts.hostsFile, "", opts.apply, "hosts");
    bool ok2 = writeFencedFile(opts.sshConfigFile, "", opts.apply, "ssh-config");
    return (ok1 && ok2) ? 0 : 1;
  }

  const std::string jsonText = readFileText(opts.configPath);
  if (jsonText.empty()) {
    std::cerr << "[ERROR] Could not read config: " << opts.configPath << "\n";
    return 1;
  }
  const auto hosts = extractHostsFromJson(jsonText);
  if (hosts.empty()) {
    std::cerr << "[ERROR] No \"host\" entries found in " << opts.configPath << "\n";
    return 1;
  }

  const std::string hostsBlock = buildHostsBlock(hosts, opts.ip);
  const std::string sshBlock = buildSshBlock(hosts, opts.sshHost, opts.sshUser);

  bool ok1 = writeFencedFile(opts.hostsFile, hostsBlock, opts.apply, "hosts");
  bool ok2 = writeFencedFile(opts.sshConfigFile, sshBlock, opts.apply, "ssh-config");
  if (!opts.apply) {
    std::cout << "\n(Dry-run only — re-run with --apply to write changes.)\n";
  }
  return (ok1 && ok2) ? 0 : 1;
}
