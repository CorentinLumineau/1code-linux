# 1Code Linux Installer

Unofficial Linux installer for [1Code](https://github.com/21st-dev/1code) by [21st.dev](https://21st.dev) - AI-powered code assistant.

> **Note:** This is a community installer script. 1Code is developed by 21st.dev and licensed under [Apache 2.0](https://github.com/21st-dev/1code/blob/main/LICENSE).

## Requirements

- [Bun](https://bun.sh) >= 1.0.0
- Git
- Linux (Debian/Ubuntu based)

## Install

```bash
# Install bun first (if not installed)
curl -fsSL https://bun.sh/install | bash

# Install 1Code
bunx github:CorentinLumineau/1code-linux
```

## Update

```bash
# After installation, use the update command
update-1code

# Or run directly
bunx github:CorentinLumineau/1code-linux update
```

## What it does

1. Clones the 1Code repository to `~/.local/share/1code`
2. Installs dependencies with bun
3. Downloads the Claude binary
4. Builds the Electron app
5. Packages as `.deb`
6. Installs the `.deb` package
7. Fixes Electron sandbox permissions
8. Installs `update-1code` command to `~/.local/bin`

## Uninstall

```bash
# Remove the app
sudo dpkg -r 21st-desktop

# Remove source and update command
rm -rf ~/.local/share/1code
rm ~/.local/bin/update-1code
```

## Troubleshooting

### Sandbox issues

If you get sandbox-related errors, run:

```bash
sudo chown root:root /opt/1Code/chrome-sandbox
sudo chmod 4755 /opt/1Code/chrome-sandbox
```

### PATH not configured

Add `~/.local/bin` to your PATH:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

## License

MIT
