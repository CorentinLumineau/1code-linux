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
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

// Configuration
const CONFIG = {
  repoUrl: "https://github.com/21st-dev/1code.git",
  installDir: join(homedir(), ".local/share/1code"),
  binDir: join(homedir(), ".local/bin"),
  appPath: "/opt/1Code/21st-desktop",
  sandboxPath: "/opt/1Code/chrome-sandbox",
}

// Colors for output
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
}

function log(msg: string) {
  console.log(msg)
}

function header(msg: string) {
  console.log(`${colors.cyan}${colors.bold}${msg}${colors.reset}`)
}

function success(msg: string) {
  console.log(`${colors.green}✓${colors.reset} ${msg}`)
}

function warn(msg: string) {
  console.log(`${colors.yellow}⚠${colors.reset} ${msg}`)
}

function error(msg: string) {
  console.error(`${colors.red}✗${colors.reset} ${msg}`)
}

function step(msg: string) {
  console.log(`\n${colors.bold}==> ${msg}${colors.reset}`)
}

// Check if a command exists
async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await $`which ${cmd}`.quiet()
    return true
  } catch {
    return false
  }
}

// Check if a Python module is available
async function hasPythonModule(module: string): Promise<boolean> {
  try {
    await $`python3 -c "import ${module}"`.quiet()
    return true
  } catch {
    return false
  }
}

// Get Python version
async function getPythonVersion(): Promise<string> {
  try {
    const version = await $`python3 --version`.text()
    return version.trim()
  } catch {
    return "not installed"
  }
}

// Install system packages with apt
async function installAptPackages(packages: string[]): Promise<boolean> {
  try {
    log(`    Installing: ${packages.join(", ")}`)
    await $`sudo apt-get update -qq`
    await $`sudo apt-get install -y ${packages}`
    return true
  } catch {
    return false
  }
}

// Check dependencies
async function checkDependencies() {
  step("Checking dependencies...")

  const missing: string[] = []
  const aptPackages: string[] = []

  // Check git
  if (!(await hasCommand("git"))) {
    missing.push("git")
    aptPackages.push("git")
  }

  // Check bun
  if (!(await hasCommand("bun"))) {
    missing.push("bun (curl -fsSL https://bun.sh/install | bash)")
  }

  // Check Python 3
  if (!(await hasCommand("python3"))) {
    missing.push("python3")
    aptPackages.push("python3")
  }

  // Check build essentials for native modules (node-gyp)
  if (!(await hasCommand("make"))) {
    aptPackages.push("build-essential")
  }
  if (!(await hasCommand("g++"))) {
    aptPackages.push("build-essential")
  }

  // Check for pkg-config (needed by some native modules)
  if (!(await hasCommand("pkg-config"))) {
    aptPackages.push("pkg-config")
  }

  // Check Python setuptools/distutils (needed for node-gyp)
  // Python 3.12+ removed distutils from stdlib
  if (await hasCommand("python3")) {
    const pythonVersion = await getPythonVersion()
    log(`    ${pythonVersion}`)

    if (!(await hasPythonModule("distutils"))) {
      warn("Python distutils not found (required for native modules)")
      // Need pip + setuptools to get distutils on Python 3.12+
      aptPackages.push("python3-pip", "python3-setuptools")
    } else {
      success("Python distutils available")
    }
  }

  // Remove duplicates from apt packages
  const uniqueAptPackages = [...new Set(aptPackages)]

  // If we have apt packages to install, offer to install them
  if (uniqueAptPackages.length > 0) {
    log("")
    warn("Missing system packages detected:")
    uniqueAptPackages.forEach((pkg) => console.log(`    - ${pkg}`))
    log("")

    const response = prompt("Install missing packages with apt? [Y/n] ")
    if (response?.toLowerCase() !== "n") {
      const installed = await installAptPackages(uniqueAptPackages)
      if (installed) {
        success("System packages installed")

        // On Python 3.12+, apt's setuptools doesn't shim distutils properly
        // Use pip to install setuptools which provides the proper shim
        if (uniqueAptPackages.includes("python3-pip") && !(await hasPythonModule("distutils"))) {
          log("    Installing setuptools via pip for distutils support...")
          try {
            await $`python3 -m pip install --user --break-system-packages setuptools`.quiet()
            if (await hasPythonModule("distutils")) {
              success("Python distutils now available")
            } else {
              warn("distutils still not available - native module builds may fail")
            }
          } catch {
            warn("pip install setuptools failed")
          }
        }
      } else {
        error("Failed to install some packages")
        log("    Try manually: sudo apt install " + uniqueAptPackages.join(" "))
      }
    }
  }

  // Check for non-apt dependencies that are still missing
  const stillMissing: string[] = []
  if (!(await hasCommand("git"))) stillMissing.push("git")
  if (!(await hasCommand("bun"))) stillMissing.push("bun (curl -fsSL https://bun.sh/install | bash)")
  if (!(await hasCommand("python3"))) stillMissing.push("python3")

  if (stillMissing.length > 0) {
    error("Missing required dependencies:")
    stillMissing.forEach((dep) => console.log(`    - ${dep}`))
    process.exit(1)
  }

  success("All dependencies satisfied")
}

// Get latest tag from remote
async function getLatestTag(): Promise<string> {
  const tagsOutput = await $`git ls-remote --tags --sort=-v:refname ${CONFIG.repoUrl}`.text()
  const firstLine = tagsOutput.split("\n")[0] || ""
  return firstLine.replace(/.*refs\/tags\//, "").replace(/\^{}$/, "").trim()
}

// Get current tag in repo
async function getCurrentTag(): Promise<string> {
  try {
    return (await $`git describe --tags --exact-match 2>/dev/null`.text()).trim()
  } catch {
    return "none"
  }
}

// Clone repository
async function cloneRepo(tag: string) {
  step(`Cloning 1code repository (${tag})...`)
  await $`mkdir -p ${join(CONFIG.installDir, "..")}`
  await $`git clone --depth 1 --branch ${tag} ${CONFIG.repoUrl} ${CONFIG.installDir}`
}

// Update repository
async function updateRepo(tag: string) {
  step(`Updating to ${tag}...`)

  // Check for uncommitted changes
  try {
    await $`git diff-index --quiet HEAD --`.quiet()
  } catch {
    warn("You have uncommitted changes.")
    const response = prompt("Stash changes and continue? [y/N] ")

    if (response?.toLowerCase() === "y") {
      await $`git stash push -m "Auto-stash before update to ${tag}"`
      success("Changes stashed. Run 'git stash pop' to restore.")
    } else {
      error("Aborting. Please commit or stash your changes first.")
      process.exit(1)
    }
  }

  await $`git checkout ${tag}`
}

// Rebuild native modules for Electron
async function rebuildNativeModules() {
  step("Rebuilding native modules for Electron...")

  try {
    await $`npx electron-rebuild -f -w better-sqlite3,node-pty`
    success("Native modules rebuilt successfully")
  } catch (err) {
    warn("electron-rebuild failed (this may be okay if modules were pre-built)")
    log("    If 1Code fails to start, run manually:")
    log("    cd ~/.local/share/1code && npx electron-rebuild -f -w better-sqlite3,node-pty")
  }
}

// Build the application
async function buildApp() {
  step("Installing dependencies...")
  // Remove lockfile to force fresh resolution
  await $`rm -f bun.lock bun.lockb`.nothrow()

  // Skip postinstall electron-rebuild (we'll do it manually with better error handling)
  await $`VERCEL=1 bun install`

  step("Updating dependencies to latest compatible versions...")
  await $`VERCEL=1 bun update`

  // Rebuild native modules manually
  await rebuildNativeModules()

  step("Downloading Claude binary...")
  await $`bun run claude:download`

  step("Building application...")
  await $`bun run build`

  step("Packaging for Linux...")
  // Patch source-map-support to handle Bun's invalid column=-1 in source maps
  // This replaces the package with a no-op to prevent crashes during electron-builder
  await $`echo 'module.exports={install:()=>{}}' > node_modules/source-map-support/source-map-support.js`.nothrow()
  await $`bun run package:linux`
}

// Install the .deb package
async function installDeb() {
  const debFiles = await $`ls -t release/*.deb 2>/dev/null | head -1`.text()
  const debFile = debFiles.trim()

  if (!debFile) {
    error("No .deb file found in release/")
    process.exit(1)
  }

  step(`Installing ${debFile}...`)
  log("    (requires sudo password)")
  await $`sudo dpkg -i ${debFile}`

  // Fix sandbox permissions
  if (existsSync(CONFIG.sandboxPath)) {
    step("Fixing Electron sandbox permissions...")
    await $`sudo chown root:root ${CONFIG.sandboxPath}`
    await $`sudo chmod 4755 ${CONFIG.sandboxPath}`
  }

  // Update desktop database
  step("Updating desktop database...")
  await $`sudo update-desktop-database 2>/dev/null || true`.quiet().nothrow()
  await $`sudo gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true`.quiet().nothrow()
}

// Install update command to PATH
async function installUpdateCommand() {
  step("Installing update command...")
  await $`mkdir -p ${CONFIG.binDir}`

  const updateScript = `#!/bin/bash
bunx github:CorentinLumineau/1code-linux update
`
  await Bun.write(join(CONFIG.binDir, "update-1code"), updateScript)
  await $`chmod +x ${join(CONFIG.binDir, "update-1code")}`
}

// Main install function
async function install() {
  header("========================================")
  header("  1Code Linux Installer (Unofficial)")
  header("========================================")

  await checkDependencies()

  const isUpdate = existsSync(join(CONFIG.installDir, ".git"))

  if (isUpdate) {
    warn("Existing installation found. Use 'update' command instead.")
    const response = prompt("Continue with reinstall? [y/N] ")
    if (response?.toLowerCase() !== "y") {
      process.exit(0)
    }
  }

  const latestTag = await getLatestTag()
  log(`\n  Latest version: ${latestTag}`)

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

  // Verify
  log("")
  header("========================================")
  if (existsSync(CONFIG.appPath)) {
    success("Installation successful!")
    log("")
    log("  Launch: 1Code from application menu")
    log("  Update: update-1code")
    log("")

    const pathEnv = process.env.PATH || ""
    if (!pathEnv.includes(CONFIG.binDir)) {
      warn(`Add ${CONFIG.binDir} to your PATH:`)
      log(`    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc`)
    }
  } else {
    error("Installation may have failed")
    log("  Try running: sudo dpkg -i release/*.deb")
  }
  header("========================================")
}

// Main update function
async function update() {
  header("========================================")
  header("  1Code Linux Updater (Unofficial)")
  header("========================================")

  if (!existsSync(join(CONFIG.installDir, ".git"))) {
    error("1Code is not installed.")
    log("Run: bunx github:CorentinLumineau/1code-linux")
    process.exit(1)
  }

  await checkDependencies()
  process.chdir(CONFIG.installDir)

  step("Fetching latest from origin...")
  await $`git fetch --tags`
  await $`git fetch origin main`

  const latestTag = await getLatestTag()
  const currentTag = await getCurrentTag()

  log(`    Current: ${currentTag}`)
  log(`    Latest:  ${latestTag}`)

  if (currentTag === latestTag) {
    log("")
    success("Already on latest version")

    const response = prompt("Rebuild anyway? [y/N] ")
    if (response?.toLowerCase() !== "y") {
      process.exit(0)
    }
  } else {
    await updateRepo(latestTag)
  }

  await buildApp()
  await installDeb()

  // Verify
  log("")
  header("========================================")
  if (existsSync(CONFIG.appPath)) {
    success("Update successful!")
    log("  Launch 1Code from your application menu")
  } else {
    error("Update may have failed")
  }
  header("========================================")
}

// CLI entry point
const command = process.argv[2] || "install"

switch (command) {
  case "install":
    await install()
    break
  case "update":
    await update()
    break
  case "help":
  case "--help":
  case "-h":
    log(`
1Code Linux Installer

Usage:
  bunx github:CorentinLumineau/1code-linux [command]

Commands:
  install   Install 1Code (default)
  update    Update existing installation
  help      Show this help message

Examples:
  bunx github:CorentinLumineau/1code-linux          # Install
  bunx github:CorentinLumineau/1code-linux update   # Update
  update-1code                               # Update (after install)
`)
    break
  default:
    error(`Unknown command: ${command}`)
    log("Run with --help for usage information")
    process.exit(1)
}
