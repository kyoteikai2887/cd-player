# Installer components

The installed application also retains its Node, npm, Rust and font license collection in the parent licenses directory.

- NSIS 3.11: official binary archive selected and hash-verified by Tauri CLI 2.12.1, https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip . COPYING is reproduced as NSIS-COPYING.txt. This installer selects zlib compression. Source: https://sourceforge.net/projects/nsis/files/NSIS%203/3.11/nsis-3.11-src.tar.bz2/download .
- nsis-tauri-utils 0.5.3: https://github.com/tauri-apps/nsis-tauri-utils/tree/nsis_tauri_utils-v0.5.3 . The two license files are reproduced unchanged; the plugin binary is downloaded and verified by the locked Tauri CLI.
- Installer template: https://github.com/tauri-apps/tauri/tree/tauri-cli-v2.12.1 . License texts are already included at ../npm/@tauri-apps+cli@2.12.1/LICENSE-MIT and LICENSE-APACHE-2.0. Local changes prevent forced shutdown and retain application data. Template provenance and hash are in source src-tauri/windows/UPSTREAM.json.

The NSIS compiler and source archives are build tools; they are not installed as application executables.
