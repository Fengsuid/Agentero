pub mod discover;

pub use discover::{path_entries, probe_command, resolve_command, resolve_command_in_paths};

/// Win32 `CREATE_NO_WINDOW` process creation flag.
///
/// The released Host is a GUI-subsystem binary, so Windows allocates a visible
/// console window for every console child process spawned without this flag.
/// `gh` (the Skill-import GitHub CLI fallback) is a console program, so each
/// `gh api` / `gh auth token` call would otherwise flash a black terminal (#741).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Hide the console window a spawned console program would otherwise get on
/// Windows. No-op on other platforms.
pub fn hide_console_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// [`hide_console_window`] for `tokio::process::Command`.
pub fn hide_console_window_tokio(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Remove the extended-length prefix from local Windows drive paths before
/// handing them to cmd.exe or MSYS2 shells. UNC/device paths retain their own
/// semantics and must not be turned into relative paths by stripping `\\?\`.
pub fn windows_shell_path(path: &std::path::Path) -> std::path::PathBuf {
    let value = path.to_string_lossy();
    match value.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.into(),
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_shell_path_strips_extended_prefix() {
        // Rust canonicalize() hands back extended-length drive paths; cmd.exe
        // and MSYS2 shells cannot cd into them, so callers get the plain form.
        assert_eq!(
            windows_shell_path(std::path::Path::new(r"\\?\D:\Documents\Zotero")),
            std::path::PathBuf::from(r"D:\Documents\Zotero")
        );
        assert_eq!(
            windows_shell_path(std::path::Path::new(r"D:\Documents\Zotero")),
            std::path::PathBuf::from(r"D:\Documents\Zotero")
        );
        // UNC layouts have no plain drive form and stay unchanged.
        assert_eq!(
            windows_shell_path(std::path::Path::new(r"\\?\UNC\server\share")),
            std::path::Path::new(r"\\?\UNC\server\share")
        );
        // POSIX paths pass through untouched.
        assert_eq!(
            windows_shell_path(std::path::Path::new("/home/user/vault")),
            std::path::Path::new("/home/user/vault")
        );
    }
}
