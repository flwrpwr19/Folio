use crate::AppState;
use std::path::PathBuf;
use tauri::State;

#[derive(serde::Serialize, Clone)]
pub struct ImageClassification {
    pub label: String,
    pub confidence: f64,
}

#[tauri::command]
pub async fn macos_haptic_tick(style: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let style = style.unwrap_or_else(|| "light".to_string());
        tauri::async_runtime::spawn_blocking(move || {
            crate::commands::macos_bridge::haptic_tick(&style)
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = style;
        Ok(())
    }
}

#[tauri::command]
pub async fn classify_image_path(
    path: String,
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<Vec<ImageClassification>, String> {
    let p = PathBuf::from(&path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            crate::commands::macos_bridge::classify_image(&p).map(|rows| {
                rows.into_iter()
                    .map(|r| ImageClassification {
                        label: r.label,
                        confidence: r.confidence,
                    })
                    .collect()
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = p;
        Ok(vec![])
    }
}

#[tauri::command]
pub async fn play_live_photo_native(
    video_path: String,
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<(), String> {
    let p = PathBuf::from(&video_path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            crate::commands::macos_bridge::play_live_photo_video(&p)
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Live Photo playback requires macOS".to_string())
    }
}
