use super::resolve_engine;
use crate::core::error::{ApiResult, AppError};
use serde::Serialize;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::process::Command;

pub(super) fn prepare_command(command: &mut Command, executable: &Path) {
    if let Some(dir) = executable.parent() {
        let mut paths = vec![dir.to_path_buf()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        if let Ok(value) = std::env::join_paths(paths) {
            command.env("PATH", value);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command.kill_on_drop(true);
}

async fn tool_output(name: &str, args: &[String], cwd: &Path) -> Result<String, String> {
    let executable =
        resolve_engine(name).ok_or_else(|| format!("{name} not found on this system"))?;
    let mut command = Command::new(&executable);
    prepare_command(&mut command, &executable);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SyncTeX honors these variables by launching another app; this API only
    // queries coordinates and must never execute the user's viewer command.
    command
        .env_remove("SYNCTEX_VIEWER")
        .env_remove("SYNCTEX_EDITOR");
    let child = command
        .spawn()
        .map_err(|e| format!("failed to run {name}: {e}"))?;
    let output = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
        .await
        .map_err(|_| format!("{name} timed out"))?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "{name}: {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(2000)
                .collect::<String>()
        ));
    }
    String::from_utf8(output.stdout).map_err(|_| format!("{name} returned non-UTF-8 output"))
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncTexLocation {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncTexSource {
    pub path: String,
    pub line: u32,
    pub column: u32,
}

fn parse_forward(text: &str) -> Vec<SyncTexLocation> {
    let mut locations = Vec::new();
    let mut current = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key == "Page" {
            if let Some(location) = current.take() {
                locations.push(location);
            }
            current = value.trim().parse().ok().map(|page| SyncTexLocation {
                page,
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            });
        } else if let Some(location) = current.as_mut() {
            let Ok(value) = value.trim().parse::<f64>() else {
                continue;
            };
            if !value.is_finite() {
                continue;
            }
            match key {
                "x" => location.x = value,
                "y" => location.y = value,
                "W" => location.width = value.abs(),
                "H" => location.height = value.abs(),
                _ => {}
            }
        }
    }
    if let Some(location) = current {
        locations.push(location);
    }
    locations.into_iter().filter(|v| v.page > 0).collect()
}

#[tauri::command]
#[specta::specta]
pub async fn latex_synctex_forward(
    pdf_path: String,
    tex_path: String,
    line: u32,
    column: u32,
) -> ApiResult<Vec<SyncTexLocation>> {
    if line == 0 || !Path::new(&pdf_path).is_file() {
        return ApiResult::err(AppError::message(
            "PDF is missing or source line is invalid",
        ));
    }
    let args = vec![
        "view".into(),
        "-i".into(),
        format!("{line}:{column}:{tex_path}"),
        "-o".into(),
        pdf_path.clone(),
    ];
    match tool_output(
        "synctex",
        &args,
        Path::new(&tex_path).parent().unwrap_or(Path::new(".")),
    )
    .await
    {
        Ok(text) => ApiResult::ok(parse_forward(&text)),
        Err(e) => ApiResult::err(AppError::message(e)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn latex_synctex_backward(
    pdf_path: String,
    page: u32,
    x: f64,
    y: f64,
) -> ApiResult<Option<SyncTexSource>> {
    if page == 0 || !x.is_finite() || !y.is_finite() || !Path::new(&pdf_path).is_file() {
        return ApiResult::err(AppError::message(
            "PDF is missing or coordinates are invalid",
        ));
    }
    let cwd = Path::new(&pdf_path).parent().unwrap_or(Path::new("."));
    let args = vec![
        "edit".into(),
        "-o".into(),
        format!("{page}:{x}:{y}:{pdf_path}"),
    ];
    match tool_output("synctex", &args, cwd).await {
        Ok(text) => {
            let value = |key: &str| {
                text.lines()
                    .find_map(|line| line.strip_prefix(key))
                    .map(str::trim)
            };
            let found = value("Input:")
                .zip(value("Line:").and_then(|v| v.parse::<u32>().ok()))
                .map(|(path, line)| {
                    let path = Path::new(path);
                    let path = if path.is_absolute() {
                        path.to_path_buf()
                    } else {
                        cwd.join(path)
                    };
                    SyncTexSource {
                        path: super::root::normalize_lexical(&path)
                            .to_string_lossy()
                            .into_owned(),
                        line: line.max(1),
                        column: value("Column:")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(1)
                            .max(1),
                    }
                });
            ApiResult::ok(found)
        }
        Err(e) => ApiResult::err(AppError::message(e)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn latex_clean(
    root_path: String,
    build: Option<super::types::LatexBuildOptions>,
) -> ApiResult<()> {
    let root = Path::new(&root_path);
    if !root.is_file() {
        return ApiResult::err(AppError::message("LaTeX root file does not exist"));
    }
    let artifact = match super::types::artifacts(root, &build.unwrap_or_default()) {
        Ok(v) => v,
        Err(e) => return ApiResult::err(AppError::message(e)),
    };
    let name = Path::new(&artifact.pdf_path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let args = vec![
        "-c".into(),
        format!("-outdir={}", artifact.out_dir),
        format!("-auxdir={}", artifact.aux_dir),
        format!("-jobname={name}"),
        root_path.clone(),
    ];
    match tool_output("latexmk", &args, root.parent().unwrap_or(Path::new("."))).await {
        Ok(_) => ApiResult::ok(()),
        Err(e) => ApiResult::err(AppError::message(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forward_sync_preserves_top_left_points_and_multiple_records() {
        let values = parse_forward("SyncTeX result begin\nPage:1\nx:72.5\ny:100.0\nW:200\nH:12\nPage:2\nx:80\ny:110\nW:190\nH:10\nSyncTeX result end");
        assert_eq!(values.len(), 2);
        assert_eq!(values[0].x, 72.5);
        assert_eq!(values[1].page, 2);
    }
}
