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

// Check dependencies
async function checkDependencies() {
  const missing: string[] = []

  if (!(await hasCommand("git"))) {
    missing.push("git (sudo apt install git)")
  }
  if (!(await hasCommand("bun"))) {
    missing.push("bun (curl -fsSL https://bun.sh/install | bash)")
  }

  if (missing.length > 0) {
    error("Missing required dependencies:")
    missing.forEach((dep) => console.log(`  - ${dep}`))
    process.exit(1)
  }
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

// Build the application
async function buildApp() {
  step("Installing dependencies...")
  await $`bun install`

  step("Downloading Claude binary...")
  await $`bun run claude:download`

  step("Building application...")
  await $`bun run build`

  step("Packaging for Linux...")
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
