#!/usr/bin/env bun
/**
 * 1Code Linux Installer/Updater (Unofficial)
 *
 * This is an unofficial community installer that builds 1Code from source.
 * 1Code is developed by 21st.dev - https://github.com/21st-dev/agents
 *
 * Usage:
 *   bunx github:CorentinLumineau/1code-linux          # Install or update
 *   bunx github:CorentinLumineau/1code-linux install  # Fresh install
 *   bunx github:CorentinLumineau/1code-linux update   # Update existing
 */

import { $ } from "bun"
import { existsSync, readdirSync, statSync } from "fs"
import { homedir } from "os"
import { join, basename } from "path"

// ============================================================
// Constants & Configuration
// ============================================================

const INSTALLER_VERSION = "1.0.3"
const INSTALLER_REPO = "CorentinLumineau/1code-linux"

const CONFIG = {
  repoUrl: "https://github.com/21st-dev/1code.git",
  installerRepoUrl: `https://github.com/${INSTALLER_REPO}`,
  installDir: join(homedir(), ".local/share/1code"),
  binDir: join(homedir(), ".local/bin"),
  appPath: "/opt/1Code/21st-desktop",
  sandboxPath: "/opt/1Code/chrome-sandbox",
  configDir: join(homedir(), ".config/21st-desktop"),
  backupDir: join(homedir(), ".config/21st-desktop-backups"),
  maxBackups: 5,
} as const

// Critical files that must exist for settings to be considered valid
const CRITICAL_SETTINGS_FILES = ["data/agents.db"] as const

// Additional files to display in diagnostics (non-critical)
const OPTIONAL_SETTINGS_FILES = ["auth.dat", "window-settings.json"] as const

// All files to display in diagnostics (critical + optional)
const DIAGNOSTIC_FILES = [...CRITICAL_SETTINGS_FILES, ...OPTIONAL_SETTINGS_FILES] as const

// ============================================================
// Logger - Single Responsibility for output formatting
// ============================================================

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
} as const

const logger = {
  log: (msg: string) => console.log(msg),
  header: (msg: string) => console.log(`${colors.cyan}${colors.bold}${msg}${colors.reset}`),
  success: (msg: string) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warn: (msg: string) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: (msg: string) => console.error(`${colors.red}✗${colors.reset} ${msg}`),
  step: (msg: string) => console.log(`\n${colors.bold}==> ${msg}${colors.reset}`),
  banner: (title: string) => {
    logger.header("========================================")
    logger.header(`  ${title}`)
    logger.header(`        Installer v${INSTALLER_VERSION}`)
    logger.header("========================================")
  },
  divider: () => logger.header("========================================"),
}

// ============================================================
// File System Utilities
// ============================================================

/** Safely get file stats, returns null if file doesn't exist or error occurs */
function safeStatSync(path: string): { size: number } | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

// ============================================================
// Command Execution Utilities
// ============================================================

/** Check if a command exists in PATH */
async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await $`which ${cmd}`.quiet()
    return true
  } catch {
    return false
  }
}

/** Check if a Python module is available */
async function hasPythonModule(module: string): Promise<boolean> {
  try {
    await $`python3 -c "import ${module}"`.quiet()
    return true
  } catch {
    return false
  }
}

/** Get Python version string */
async function getPythonVersion(): Promise<string> {
  try {
    return (await $`python3 --version`.text()).trim()
  } catch {
    return "not installed"
  }
}

/** Check if a process is running by name */
async function isProcessRunning(processName: string): Promise<boolean> {
  try {
    await $`pgrep -x ${processName}`.quiet()
    return true
  } catch {
    return false
  }
}

// ============================================================
// Backup & Restore - Single Responsibility
// ============================================================

interface BackupResult {
  success: boolean
  path?: string
  error?: string
}

interface RestoreResult {
  success: boolean
  error?: string
}

/** List available backups sorted by date (newest first) */
function listBackups(): string[] {
  if (!existsSync(CONFIG.backupDir)) return []
  return readdirSync(CONFIG.backupDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("backup-"))
    .map((e) => join(CONFIG.backupDir, e.name))
    .sort()
    .reverse()
}

/** Remove old backups to maintain maxBackups limit */
async function rotateBackups(): Promise<void> {
  const backups = listBackups()
  // Keep maxBackups - 1 since we're about to create a new one
  for (const backup of backups.slice(CONFIG.maxBackups - 1)) {
    await $`rm -rf ${backup}`.nothrow()
  }
}

/** Verify a backup was created successfully */
function verifyBackup(backupPath: string): boolean {
  // Check that at least the critical files were copied
  for (const file of CRITICAL_SETTINGS_FILES) {
    const sourcePath = join(CONFIG.configDir, file)
    const backupFilePath = join(backupPath, file)
    // Only verify files that exist in source
    if (existsSync(sourcePath) && !existsSync(backupFilePath)) {
      return false
    }
  }
  return true
}

/** Create a backup of current settings */
async function backupSettings(): Promise<BackupResult> {
  if (!existsSync(CONFIG.configDir)) {
    return { success: true } // Nothing to backup is not an error
  }

  try {
    await rotateBackups()

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const backupPath = join(CONFIG.backupDir, `backup-${timestamp}`)

    await $`mkdir -p ${backupPath}`
    const result = await $`cp -r ${CONFIG.configDir}/* ${backupPath}/`.nothrow()

    if (result.exitCode !== 0) {
      return { success: false, error: "Copy command failed" }
    }

    if (!verifyBackup(backupPath)) {
      return { success: false, path: backupPath, error: "Backup verification failed" }
    }

    return { success: true, path: backupPath }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/** Restore settings from a backup */
async function restoreSettings(backupPath: string): Promise<RestoreResult> {
  if (!existsSync(backupPath)) {
    return { success: false, error: "Backup path does not exist" }
  }

  try {
    await $`mkdir -p ${CONFIG.configDir}`
    const result = await $`cp -r ${backupPath}/* ${CONFIG.configDir}/`.nothrow()

    if (result.exitCode !== 0) {
      return { success: false, error: "Copy command failed" }
    }

    // Verify restore succeeded
    const { ok } = verifySettings()
    if (!ok) {
      return { success: false, error: "Restore verification failed" }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/** Verify critical settings files exist */
function verifySettings(): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  for (const file of CRITICAL_SETTINGS_FILES) {
    const path = join(CONFIG.configDir, file)
    if (!existsSync(path)) missing.push(file)
  }
  return { ok: missing.length === 0, missing }
}

// ============================================================
// Diagnostics
// ============================================================

/** Check keyring daemon status */
async function checkKeyringStatus(): Promise<{ running: boolean; name?: string }> {
  if (await isProcessRunning("gnome-keyring-d")) {
    return { running: true, name: "GNOME Keyring" }
  }
  if (await isProcessRunning("kwalletd5")) {
    return { running: true, name: "KWallet" }
  }
  return { running: false }
}

/** Run settings diagnostics */
async function diagSettings(): Promise<void> {
  logger.banner("1Code Settings Diagnostics")

  // Config directory check
  logger.step("Config directory: " + CONFIG.configDir)
  if (!existsSync(CONFIG.configDir)) {
    logger.warn("Not found (normal for fresh install)")
  } else {
    logger.success("Found")
    for (const file of DIAGNOSTIC_FILES) {
      const path = join(CONFIG.configDir, file)
      const stats = safeStatSync(path)
      if (stats) {
        logger.log(`    ${file}: ${stats.size} bytes`)
      } else {
        logger.warn(`    ${file}: NOT FOUND`)
      }
    }
  }

  // Keyring check
  logger.step("Secret Service (for auth encryption)")
  const keyring = await checkKeyringStatus()
  if (keyring.running) {
    logger.success(`${keyring.name} daemon running`)
  } else {
    logger.warn("No keyring daemon detected - auth tokens may not persist")
    logger.log("    Install: sudo apt install gnome-keyring")
  }

  // Backups check
  logger.step("Available backups")
  const backups = listBackups()
  if (backups.length === 0) {
    logger.log("    None")
  } else {
    backups.forEach((b) => logger.log(`    ${basename(b)}`))
  }

  logger.divider()
}

// ============================================================
// Package Management
// ============================================================

/** Install system packages with apt */
async function installAptPackages(packages: string[]): Promise<boolean> {
  try {
    logger.log(`    Installing: ${packages.join(", ")}`)
    await $`sudo apt-get update -qq`
    await $`sudo apt-get install -y ${packages}`
    return true
  } catch {
    return false
  }
}

/** Check and install dependencies */
async function checkDependencies(): Promise<void> {
  logger.step("Checking dependencies...")

  const aptPackages: string[] = []

  // Check required commands
  const requiredCommands = [
    { cmd: "git", pkg: "git" },
    { cmd: "make", pkg: "build-essential" },
    { cmd: "g++", pkg: "build-essential" },
    { cmd: "pkg-config", pkg: "pkg-config" },
  ]

  for (const { cmd, pkg } of requiredCommands) {
    if (!(await hasCommand(cmd))) {
      aptPackages.push(pkg)
    }
  }

  // Check bun (not available via apt)
  const hasBun = await hasCommand("bun")

  // Check Python
  const hasPython = await hasCommand("python3")
  if (!hasPython) {
    aptPackages.push("python3")
  } else {
    const pythonVersion = await getPythonVersion()
    logger.log(`    ${pythonVersion}`)

    if (!(await hasPythonModule("distutils"))) {
      logger.warn("Python distutils not found (required for native modules)")
      aptPackages.push("python3-pip", "python3-setuptools")
    } else {
      logger.success("Python distutils available")
    }
  }

  // Install apt packages if needed
  const uniqueAptPackages = [...new Set(aptPackages)]
  if (uniqueAptPackages.length > 0) {
    logger.log("")
    logger.warn("Missing system packages detected:")
    uniqueAptPackages.forEach((pkg) => logger.log(`    - ${pkg}`))
    logger.log("")

    const response = prompt("Install missing packages with apt? [Y/n] ")
    if (response?.toLowerCase() !== "n") {
      const installed = await installAptPackages(uniqueAptPackages)
      if (installed) {
        logger.success("System packages installed")

        // Handle Python 3.12+ distutils shim
        if (uniqueAptPackages.includes("python3-pip") && !(await hasPythonModule("distutils"))) {
          logger.log("    Installing setuptools via pip for distutils support...")
          try {
            await $`python3 -m pip install --user --break-system-packages setuptools`.quiet()
            if (await hasPythonModule("distutils")) {
              logger.success("Python distutils now available")
            } else {
              logger.warn("distutils still not available - native module builds may fail")
            }
          } catch {
            logger.warn("pip install setuptools failed")
          }
        }
      } else {
        logger.error("Failed to install some packages")
        logger.log("    Try manually: sudo apt install " + uniqueAptPackages.join(" "))
      }
    }
  }

  // Final verification
  const stillMissing: string[] = []
  if (!(await hasCommand("git"))) stillMissing.push("git")
  if (!hasBun && !(await hasCommand("bun"))) {
    stillMissing.push("bun (curl -fsSL https://bun.sh/install | bash)")
  }
  if (!(await hasCommand("python3"))) stillMissing.push("python3")

  if (stillMissing.length > 0) {
    logger.error("Missing required dependencies:")
    stillMissing.forEach((dep) => logger.log(`    - ${dep}`))
    process.exit(1)
  }

  logger.success("All dependencies satisfied")
}

// ============================================================
// Version Management
// ============================================================

/** Compare semver versions: -1 if a < b, 0 if equal, 1 if a > b */
function compareVersions(a: string, b: string): number {
  const partsA = a.replace(/^v/, "").split(".").map(Number)
  const partsB = b.replace(/^v/, "").split(".").map(Number)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0
    const numB = partsB[i] || 0
    if (numA < numB) return -1
    if (numA > numB) return 1
  }
  return 0
}

/** Check for installer updates */
async function checkInstallerUpdate(): Promise<void> {
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/${INSTALLER_REPO}/main/package.json`
    )
    if (!response.ok) return

    const pkg = await response.json()
    const remoteVersion = pkg.version as string

    if (compareVersions(INSTALLER_VERSION, remoteVersion) < 0) {
      logger.log("")
      logger.warn(`Installer update available: ${INSTALLER_VERSION} → ${remoteVersion}`)
      logger.log(`    Run: bunx --bun github:${INSTALLER_REPO}`)
      logger.log("")
    }
  } catch {
    // Silently ignore update check failures
  }
}

/** Get latest tag from remote repository */
async function getLatestTag(): Promise<string> {
  const tagsOutput = await $`git ls-remote --tags --sort=-v:refname ${CONFIG.repoUrl}`.text()
  const firstLine = tagsOutput.split("\n")[0] || ""
  return firstLine.replace(/.*refs\/tags\//, "").replace(/\^{}$/, "").trim()
}

/** Get current tag in local repository */
async function getCurrentTag(): Promise<string> {
  try {
    return (await $`git describe --tags --exact-match 2>/dev/null`.text()).trim()
  } catch {
    return "none"
  }
}

// ============================================================
// Git Operations
// ============================================================

/** Clone repository to install directory */
async function cloneRepo(tag: string): Promise<void> {
  logger.step(`Cloning 1code repository (${tag})...`)
  await $`mkdir -p ${join(CONFIG.installDir, "..")}`
  await $`git clone --depth 1 --branch ${tag} ${CONFIG.repoUrl} ${CONFIG.installDir}`
}

/** Update repository to specified tag */
async function updateRepo(tag: string): Promise<void> {
  logger.step(`Updating to ${tag}...`)

  // Check for uncommitted changes
  try {
    await $`git diff-index --quiet HEAD --`.quiet()
  } catch {
    logger.warn("You have uncommitted changes.")
    const response = prompt("Stash changes and continue? [y/N] ")

    if (response?.toLowerCase() === "y") {
      await $`git stash push -m "Auto-stash before update to ${tag}"`
      logger.success("Changes stashed. Run 'git stash pop' to restore.")
    } else {
      logger.error("Aborting. Please commit or stash your changes first.")
      process.exit(1)
    }
  }

  await $`git checkout ${tag}`
}

// ============================================================
// Build & Install
// ============================================================

/** Rebuild native modules for Electron */
async function rebuildNativeModules(): Promise<void> {
  logger.step("Rebuilding native modules for Electron...")

  try {
    await $`npx electron-rebuild -f -w better-sqlite3,node-pty`
    logger.success("Native modules rebuilt successfully")
  } catch {
    logger.warn("electron-rebuild failed (this may be okay if modules were pre-built)")
    logger.log("    If 1Code fails to start, run manually:")
    logger.log("    cd ~/.local/share/1code && npx electron-rebuild -f -w better-sqlite3,node-pty")
  }
}

/** Build the application from source */
async function buildApp(): Promise<void> {
  logger.step("Installing dependencies...")
  await $`rm -f bun.lock bun.lockb`.nothrow()
  await $`VERCEL=1 bun install`

  logger.step("Updating dependencies to latest compatible versions...")
  await $`VERCEL=1 bun update`

  await rebuildNativeModules()

  logger.step("Downloading Claude binary...")
  await $`bun run claude:download`

  logger.step("Building application...")
  await $`bun run build`

  logger.step("Packaging for Linux...")
  await $`echo 'module.exports={install:()=>{}}' > node_modules/source-map-support/source-map-support.js`.nothrow()
  await $`CI=true NO_COLOR=1 TERM=dumb bun run package:linux`
}

/** Install the .deb package */
async function installDeb(): Promise<void> {
  const debFiles = await $`ls -t release/*.deb 2>/dev/null | head -1`.text()
  const debFile = debFiles.trim()

  if (!debFile) {
    logger.error("No .deb file found in release/")
    process.exit(1)
  }

  logger.step(`Installing ${debFile}...`)
  logger.log("    (requires sudo password)")
  await $`sudo dpkg -i ${debFile}`

  if (existsSync(CONFIG.sandboxPath)) {
    logger.step("Fixing Electron sandbox permissions...")
    await $`sudo chown root:root ${CONFIG.sandboxPath}`
    await $`sudo chmod 4755 ${CONFIG.sandboxPath}`
  }

  logger.step("Updating desktop database...")
  await $`sudo update-desktop-database 2>/dev/null || true`.quiet().nothrow()
  await $`sudo gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true`.quiet().nothrow()
}

/** Install update command to user's PATH */
async function installUpdateCommand(): Promise<void> {
  logger.step("Installing update command...")
  await $`mkdir -p ${CONFIG.binDir}`

  const updateScript = `#!/bin/bash
bunx github:CorentinLumineau/1code-linux "$@"
`
  await Bun.write(join(CONFIG.binDir, "update-1code"), updateScript)
  await $`chmod +x ${join(CONFIG.binDir, "update-1code")}`
}

// ============================================================
// Main Commands
// ============================================================

/** Fresh installation */
async function install(): Promise<void> {
  logger.banner("1Code Linux Installer (Unofficial)")

  await checkInstallerUpdate()
  await checkDependencies()

  const isUpdate = existsSync(join(CONFIG.installDir, ".git"))

  if (isUpdate) {
    logger.warn("Existing installation found. Use 'update' command instead.")
    const response = prompt("Continue with reinstall? [y/N] ")
    if (response?.toLowerCase() !== "y") {
      process.exit(0)
    }
  }

  const latestTag = await getLatestTag()
  logger.log(`\n  Latest version: ${latestTag}`)

  if (!isUpdate) {
    await cloneRepo(latestTag)
  }

  process.chdir(CONFIG.installDir)

  if (isUpdate) {
    await $`git fetch --tags`
    await $`git fetch origin main`
    await updateRepo(latestTag)
  }

  await buildApp()
  await installDeb()
  await installUpdateCommand()

  logger.log("")
  logger.divider()
  if (existsSync(CONFIG.appPath)) {
    logger.success("Installation successful!")
    logger.log("")
    logger.log("  Launch: 1Code from application menu")
    logger.log("  Update: update-1code")
    logger.log("")

    const pathEnv = process.env.PATH || ""
    if (!pathEnv.includes(CONFIG.binDir)) {
      logger.warn(`Add ${CONFIG.binDir} to your PATH:`)
      logger.log(`    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc`)
    }
  } else {
    logger.error("Installation may have failed")
    logger.log("  Try running: sudo dpkg -i release/*.deb")
  }
  logger.divider()
}

/** Update existing installation */
async function update(): Promise<void> {
  logger.banner("1Code Linux Updater (Unofficial)")

  await checkInstallerUpdate()

  // Backup settings before update
  logger.step("Backing up settings...")
  const backupResult = await backupSettings()

  if (backupResult.success && backupResult.path) {
    logger.success(`Backup: ${basename(backupResult.path)}`)
  } else if (backupResult.success) {
    logger.log("    No existing settings to backup")
  } else {
    logger.warn(`Backup failed: ${backupResult.error}`)
  }

  if (!existsSync(join(CONFIG.installDir, ".git"))) {
    logger.error("1Code is not installed.")
    logger.log(`Run: bunx github:${INSTALLER_REPO}`)
    process.exit(1)
  }

  await checkDependencies()
  process.chdir(CONFIG.installDir)

  logger.step("Fetching latest from origin...")
  await $`git fetch --tags`
  await $`git fetch origin main`

  const latestTag = await getLatestTag()
  const currentTag = await getCurrentTag()

  logger.log(`    Current: ${currentTag}`)
  logger.log(`    Latest:  ${latestTag}`)

  if (currentTag === latestTag) {
    logger.log("")
    logger.success("Already on latest version")

    const response = prompt("Rebuild anyway? [y/N] ")
    if (response?.toLowerCase() !== "y") {
      process.exit(0)
    }
  } else {
    await updateRepo(latestTag)
  }

  await buildApp()
  await installDeb()

  // Verify settings after update
  logger.step("Verifying settings...")
  const { ok, missing } = verifySettings()

  if (!ok && backupResult.path) {
    logger.warn(`Settings affected! Missing: ${missing.join(", ")}`)
    const response = prompt("Restore from backup? [Y/n] ")
    if (response?.toLowerCase() !== "n") {
      const restoreResult = await restoreSettings(backupResult.path)
      if (restoreResult.success) {
        logger.success("Settings restored from backup")
      } else {
        logger.error(`Restore failed: ${restoreResult.error}`)
      }
    }
  } else if (!ok) {
    logger.warn(`Settings missing: ${missing.join(", ")} (no backup available)`)
  } else {
    logger.success("Settings OK")
  }

  logger.log("")
  logger.divider()
  if (existsSync(CONFIG.appPath)) {
    logger.success("Update successful!")
    logger.log("  Launch 1Code from your application menu")
  } else {
    logger.error("Update may have failed")
  }
  logger.divider()
}

/** Interactive restore from backup */
async function interactiveRestore(): Promise<void> {
  const backups = listBackups()

  if (backups.length === 0) {
    logger.error("No backups available")
    process.exit(1)
  }

  logger.log("Available backups:")
  backups.forEach((b, i) => logger.log(`  ${i + 1}. ${basename(b)}`))

  const choice = prompt("Enter number to restore (or 'q' to quit): ")
  if (choice?.toLowerCase() === "q") {
    process.exit(0)
  }

  const idx = parseInt(choice || "0") - 1
  if (idx < 0 || idx >= backups.length) {
    logger.error("Invalid selection")
    process.exit(1)
  }

  const result = await restoreSettings(backups[idx])
  if (result.success) {
    logger.success("Settings restored successfully")
    logger.log("  Restart 1Code to apply restored settings")
  } else {
    logger.error(`Failed to restore settings: ${result.error}`)
    process.exit(1)
  }
}

/** Show available backups */
function showBackups(): void {
  const backups = listBackups()

  if (backups.length === 0) {
    logger.log("No backups found")
  } else {
    logger.header("Available backups:")
    backups.forEach((b) => logger.log(`  ${basename(b)}`))
  }
}

/** Show help message */
function showHelp(): void {
  logger.log(`
1Code Linux Installer/Updater

Usage:
  bunx github:CorentinLumineau/1code-linux [command]

Commands:
  install       Install 1Code (default)
  update        Update existing installation (with backup)
  diagnose      Show settings diagnostics
  backups       List available settings backups
  restore       Restore settings from backup
  help          Show this help message

Examples:
  bunx github:CorentinLumineau/1code-linux          # Install
  bunx github:CorentinLumineau/1code-linux update   # Update with backup
  update-1code                                      # Update (after install)
  update-1code diagnose                             # Check settings status
  update-1code restore                              # Restore from backup
`)
}

// ============================================================
// CLI Entry Point
// ============================================================

const command = process.argv[2] || "install"

switch (command) {
  case "install":
    await install()
    break
  case "update":
    await update()
    break
  case "diagnose":
  case "diag":
    await diagSettings()
    break
  case "backups":
  case "list-backups":
    showBackups()
    break
  case "restore":
    await interactiveRestore()
    break
  case "help":
  case "--help":
  case "-h":
    showHelp()
    break
  default:
    logger.error(`Unknown command: ${command}`)
    logger.log("Run with --help for usage information")
    process.exit(1)
}
