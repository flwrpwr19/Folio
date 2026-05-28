use crate::AppState;
use image::GenericImageView;
use media_core::{SimpleEdit, apply_edit};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

use lru::LruCache;
use parking_lot::Mutex;
use std::num::NonZeroUsize;

pub struct ImageLruCache {
    inner: Mutex<(LruCache<String, (image::DynamicImage, usize)>, usize)>,
    max_bytes: usize,
}

impl ImageLruCache {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            inner: Mutex::new((LruCache::new(NonZeroUsize::new(1000).unwrap()), 0)),
            max_bytes,
        }
    }

    pub fn insert(&self, key: String, img: image::DynamicImage) {
        let (w, h) = img.dimensions();
        // Estimate footprint: width * height * 4 channels (RGBA)
        let byte_size = (w as usize) * (h as usize) * 4;

        let mut guard = self.inner.lock();
        let (ref mut cache, ref mut current) = *guard;

        if let Some((_, old_size)) = cache.pop(&key) {
            *current = current.saturating_sub(old_size);
        }

        while *current + byte_size > self.max_bytes && !cache.is_empty() {
            if let Some((_, (_, popped_size))) = cache.pop_lru() {
                *current = current.saturating_sub(popped_size);
            } else {
                break;
            }
        }

        cache.put(key, (img, byte_size));
        *current += byte_size;
    }

    pub fn get(&self, key: &str) -> Option<image::DynamicImage> {
        let mut guard = self.inner.lock();
        let (ref mut cache, _) = *guard;
        cache.get(key).map(|(img, _)| img.clone())
    }

    pub fn contains_key(&self, key: &str) -> bool {
        let mut guard = self.inner.lock();
        let (ref mut cache, _) = *guard;
        cache.contains(key)
    }

    pub fn clear(&self) {
        let mut guard = self.inner.lock();
        let (ref mut cache, ref mut current) = *guard;
        cache.clear();
        *current = 0;
    }
}

#[tauri::command]
pub async fn set_window_vibrancy(window: tauri::Window, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{NSVisualEffectMaterial, apply_vibrancy};
        if enabled {
            apply_vibrancy(
                &window,
                NSVisualEffectMaterial::UnderWindowBackground,
                None,
                None,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    let _ = window;
    let _ = enabled;
    Ok(())
}

#[tauri::command]
pub async fn trigger_macos_sound(name: String, volume: Option<f64>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let sound_path = match name.as_str() {
            "success" => "/System/Library/Sounds/Glass.aiff",
            "error" => "/System/Library/Sounds/Sosumi.aiff",
            "load" => "/System/Library/Sounds/Purr.aiff",
            _ => "/System/Library/Sounds/Pop.aiff",
        };
        let vol_val = volume.unwrap_or(0.4) as f32;
        let path = std::path::PathBuf::from(sound_path);

        tauri::async_runtime::spawn_blocking(move || {
            if let Ok(file) = std::fs::File::open(&path) {
                let reader = std::io::BufReader::new(file);
                if let Ok((_stream, handle)) = rodio::OutputStream::try_default() {
                    if let Ok(sink) = rodio::Sink::try_new(&handle) {
                        if let Ok(source) = rodio::Decoder::new(reader) {
                            sink.set_volume(vol_val);
                            sink.append(source);
                            sink.sleep_until_end();
                        }
                    }
                }
            }
        });
    }
    let _ = name;
    let _ = volume;
    Ok(())
}

#[tauri::command]
pub async fn get_thumbnail(
    path: String,
    max_side: u32,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
    }

    {
        let cache_key = (path.clone(), max_side);
        let mut cache = state.resolved_thumbs.lock();
        if let Some(cached_path) = cache.get(&cache_key) {
            return Ok(cached_path.clone());
        }
    }

    let state_arc = state.inner().clone();
    let path_clone = path.clone();
    let thumb_path = tauri::async_runtime::spawn_blocking(move || {
        let path_buf = PathBuf::from(&path_clone);
        let thumb_path = state_arc
            .cache
            .ensure_thumbnail(&path_buf, max_side)
            .map_err(|e| e.to_string())?;
        let thumb_str = thumb_path.to_string_lossy().to_string();

        state_arc
            .resolved_thumbs
            .lock()
            .put((path_clone, max_side), thumb_str.clone());
        Ok::<String, String>(thumb_str)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(thumb_path)
}

#[tauri::command]
pub async fn get_full_image(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
    }
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let cached = state_arc
            .cache
            .ensure_decoded(&p)
            .map_err(|e| e.to_string())?;
        Ok::<String, String>(cached.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn prepare_edit_preview(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
    }
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if state_arc.preview_cache.contains_key(&path) {
            return Ok(());
        }

        let img = if media_core::can_use_sips(&p) {
            let temp_preview = std::env::temp_dir().join(format!(
                "folio_preview_{}.jpg",
                blake3::hash(path.as_bytes()).to_hex()
            ));

            media_core::sips_output_to_file(&p, &temp_preview, Some(1024), "jpeg")
                .map_err(|e| e.to_string())?;

            image::open(&temp_preview).map_err(|e| e.to_string())?
        } else {
            let source = {
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let native = matches!(
                    ext.as_str(),
                    "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp"
                );
                if native {
                    p.clone()
                } else {
                    state_arc
                        .cache
                        .ensure_decoded(&p)
                        .map_err(|e| e.to_string())?
                }
            };

            let mut img = media_core::open_image(&source).map_err(|e| e.to_string())?;
            let orientation = state_arc
                .index
                .read()
                .as_ref()
                .and_then(|idx| idx.items.iter().find(|it| it.path == p))
                .map(|it| it.metadata.orientation)
                .unwrap_or(1);
            img = media_core::apply_orientation_value(img, orientation);

            let (w, h) = img.dimensions();
            let max_side = 1024;
            let longest = w.max(h);
            if longest > max_side {
                let scale = max_side as f32 / longest as f32;
                let nw = (w as f32 * scale).round() as u32;
                let nh = (h as f32 * scale).round() as u32;
                img = img.resize(nw, nh, image::imageops::FilterType::Triangle);
            }
            img
        };

        state_arc.preview_cache.insert(path, img);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn edit_image(
    path: String,
    edit: SimpleEdit,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
    }
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state_arc.edits.write().insert(path.clone(), edit.clone());
        let img = state_arc
            .preview_cache
            .get(&path)
            .ok_or_else(|| "preview not prepared".to_string())?;
        let edited = apply_edit(&img, &edit);
        let mut buf = Vec::new();
        let rgb = edited.into_rgb8();
        let mut cursor = Cursor::new(&mut buf);
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 85);
        image::DynamicImage::ImageRgb8(rgb)
            .write_with_encoder(encoder)
            .map_err(|e| e.to_string())?;
        Ok::<String, String>(base64_encode(&buf))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn copy_jpeg_exif(src_path: &Path, dest_path: &Path) -> Result<(), String> {
    let src_bytes = std::fs::read(src_path).map_err(|e| e.to_string())?;
    let mut dest_bytes = std::fs::read(dest_path).map_err(|e| e.to_string())?;

    let mut src_app1 = None;
    let mut i = 2;
    while i + 1 < src_bytes.len() {
        if src_bytes[i] == 0xFF {
            let marker = src_bytes[i + 1];
            if marker == 0xD9 || marker == 0xDA {
                break;
            }
            if i + 3 >= src_bytes.len() {
                break;
            }
            let len = ((src_bytes[i + 2] as usize) << 8) | (src_bytes[i + 3] as usize);
            if marker == 0xE1 {
                if i + 4 + 6 <= src_bytes.len() && &src_bytes[i + 4..i + 10] == b"Exif\0\0" {
                    if i + 2 + len <= src_bytes.len() {
                        src_app1 = Some(src_bytes[i..i + 2 + len].to_vec());
                    }
                    break;
                }
            }
            i += 2 + len;
        } else {
            i += 1;
        }
    }

    if let Some(app1) = src_app1 {
        let mut insert_pos = 2;
        let mut dest_i = 2;
        while dest_i + 1 < dest_bytes.len() {
            if dest_bytes[dest_i] == 0xFF {
                let marker = dest_bytes[dest_i + 1];
                if marker == 0xD9 || marker == 0xDA {
                    break;
                }
                if dest_i + 3 >= dest_bytes.len() {
                    break;
                }
                let len =
                    ((dest_bytes[dest_i + 2] as usize) << 8) | (dest_bytes[dest_i + 3] as usize);
                if marker == 0xE1 {
                    if dest_i + 4 + 6 <= dest_bytes.len()
                        && &dest_bytes[dest_i + 4..dest_i + 10] == b"Exif\0\0"
                    {
                        if dest_i + 2 + len <= dest_bytes.len() {
                            dest_bytes.drain(dest_i..dest_i + 2 + len);
                            insert_pos = dest_i;
                        }
                        break;
                    }
                }
                dest_i += 2 + len;
            } else {
                dest_i += 1;
            }
        }

        dest_bytes.splice(insert_pos..insert_pos, app1);
        let tmp = dest_path.with_extension(format!(
            "{}.folio-exif-tmp",
            dest_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("jpg")
        ));
        std::fs::write(&tmp, dest_bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, dest_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
    }
    Ok(())
}

#[tauri::command]
pub async fn export_edited(
    path: String,
    dest: String,
    strip_metadata: bool,
    watermark: Option<Vec<u8>>,
    watermark_anchor: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let src_p = PathBuf::from(&path);
    if !crate::is_path_safe(&src_p, &state) {
        return Err(
            "Permission denied: source path lies outside safe sandbox boundaries".to_string(),
        );
    }
    let dest_p = PathBuf::from(&dest);
    if let Some(dest_parent) = dest_p.parent() {
        if !crate::is_path_safe(&dest_parent.to_path_buf(), &state) {
            return Err(
                "Permission denied: destination path lies outside safe sandbox boundaries"
                    .to_string(),
            );
        }
    } else {
        return Err("Invalid destination path".to_string());
    }
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let edit = state_arc
            .edits
            .read()
            .get(&path)
            .cloned()
            .unwrap_or_default();
        let p = PathBuf::from(&path);
        let mut img = media_core::open_image(&p).map_err(|e| e.to_string())?;
        let orientation = state_arc
            .index
            .read()
            .as_ref()
            .and_then(|idx| idx.items.iter().find(|it| it.path == p))
            .map(|it| it.metadata.orientation)
            .unwrap_or(1);
        img = media_core::apply_orientation_value(img, orientation);
        let mut edited = apply_edit(&img, &edit);

        if let Some(wm_bytes) = watermark {
            if let Ok(wm_img) = image::load_from_memory(&wm_bytes) {
                let margin = 40;
                let anchor = watermark_anchor.as_deref().unwrap_or("bottom-right");
                let x = match anchor {
                    "bottom-left" | "top-left" => margin,
                    "top-right" | "bottom-right" => {
                        edited.width().saturating_sub(wm_img.width() + margin)
                    }
                    "center" => (edited.width().saturating_sub(wm_img.width())) / 2,
                    _ => edited.width().saturating_sub(wm_img.width() + margin),
                };
                let y = match anchor {
                    "top-left" | "top-right" => margin,
                    "bottom-left" | "bottom-right" => {
                        edited.height().saturating_sub(wm_img.height() + margin)
                    }
                    "center" => (edited.height().saturating_sub(wm_img.height())) / 2,
                    _ => edited.height().saturating_sub(wm_img.height() + margin),
                };
                image::imageops::overlay(&mut edited, &wm_img, x as i64, y as i64);
            }
        }

        let dest_path = PathBuf::from(&dest);
        let fmt = image::ImageFormat::from_path(&dest_path).unwrap_or(image::ImageFormat::Jpeg);
        let tmp_path = dest_path.with_extension(format!(
            "{}.folio-export-tmp",
            dest_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("img")
        ));
        edited
            .save_with_format(&tmp_path, fmt)
            .map_err(|e| e.to_string())?;

        if !strip_metadata && fmt == image::ImageFormat::Jpeg {
            let src_ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if src_ext == "jpg" || src_ext == "jpeg" {
                let _ = copy_jpeg_exif(&p, &tmp_path);
            }
        }
        std::fs::rename(&tmp_path, &dest_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            e.to_string()
        })?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_dominant_colors(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let p = std::path::PathBuf::from(&path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
    }
    {
        let mut cache = state.dominant_colors.lock();
        if let Some(colors) = cache.get(&path) {
            return Ok(colors.clone());
        }
    }

    if media_core::is_video_path(&p) {
        return Ok(vec![]);
    }
    let state_arc = state.inner().clone();
    let path_clone = path.clone();
    let colors = tauri::async_runtime::spawn_blocking(move || {
        let img = media_core::open_image(&p).map_err(|e| e.to_string())?;
        let colors = media_core::extract_dominant_colors(&img, 5);
        Ok::<Vec<String>, String>(colors)
    })
    .await
    .map_err(|e| e.to_string())??;

    state_arc
        .dominant_colors
        .lock()
        .put(path_clone, colors.clone());
    Ok(colors)
}

#[tauri::command]
pub async fn get_folder_dominant_colors(
    paths: Vec<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    for path in &paths {
        let p = std::path::PathBuf::from(path);
        if !crate::is_path_safe(&p, &state) {
            return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
        }
    }
    let state_arc = state.inner().clone();

    // First grab what we have in cache
    let mut results = std::collections::HashMap::new();
    let mut missing_paths = Vec::new();

    {
        let mut cache = state_arc.dominant_colors.lock();
        for path in &paths {
            if let Some(colors) = cache.get(path) {
                results.insert(path.clone(), colors.clone());
            } else {
                let p = std::path::PathBuf::from(path);
                if !media_core::is_video_path(&p) {
                    missing_paths.push(path.clone());
                } else {
                    results.insert(path.clone(), vec![]);
                }
            }
        }
    }

    if !missing_paths.is_empty() {
        let extracted: Vec<(String, Vec<String>)> =
            tauri::async_runtime::spawn_blocking(move || {
                use rayon::prelude::*;
                missing_paths
                    .into_par_iter()
                    .filter_map(|path_str| {
                        let p = std::path::PathBuf::from(&path_str);
                        if let Ok(img) = media_core::open_image(&p) {
                            let colors = media_core::extract_dominant_colors(&img, 5);
                            Some((path_str, colors))
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .await
            .map_err(|e| e.to_string())?;

        let mut cache = state_arc.dominant_colors.lock();
        for (path, colors) in extracted {
            cache.put(path.clone(), colors.clone());
            results.insert(path, colors);
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn find_visual_duplicates(
    paths: Vec<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Vec<String>>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    for path in &paths {
        let p = std::path::PathBuf::from(path);
        if !crate::is_path_safe(&p, &state) {
            return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
        }
    }

    let state_arc = state.inner().clone();
    let result: Result<Vec<(String, u64)>, String> =
        tauri::async_runtime::spawn_blocking(move || {
            use rayon::prelude::*;
            let local_hashes: Vec<(String, u64)> = paths
                .into_par_iter()
                .filter_map(|path_str| {
                    let path = std::path::Path::new(&path_str);
                    if !path.exists() {
                        return None;
                    }

                    // Try cached thumbnail first to prevent expensive full-resolution decodes
                    let img_res = if let Ok(thumb_path) = state_arc.cache.thumbnail_path(path, 320)
                    {
                        if thumb_path.exists() {
                            image::open(&thumb_path)
                        } else {
                            let ext = path
                                .extension()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_lowercase();
                            if ["mp4", "mov", "webm", "avi", "mkv"].contains(&ext.as_str()) {
                                Err(image::ImageError::IoError(std::io::Error::new(
                                    std::io::ErrorKind::Other,
                                    "Skip video thumb gen in hash",
                                )))
                            } else if let Ok(gen_path) = state_arc.cache.ensure_thumbnail(path, 320)
                            {
                                image::open(&gen_path)
                            } else {
                                Err(image::ImageError::IoError(std::io::Error::new(
                                    std::io::ErrorKind::Other,
                                    "Failed thumb",
                                )))
                            }
                        }
                    } else {
                        Err(image::ImageError::IoError(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            "No cache path",
                        )))
                    };

                    if let Ok(img) = img_res {
                        let gray = img
                            .resize_exact(9, 8, image::imageops::FilterType::Nearest)
                            .to_luma8();
                        let mut dhash: u64 = 0;
                        let mut bit_idx = 0;
                        for y in 0..8 {
                            for x in 0..8 {
                                let p1 = gray.get_pixel(x, y)[0];
                                let p2 = gray.get_pixel(x + 1, y)[0];
                                if p2 > p1 {
                                    dhash |= 1 << bit_idx;
                                }
                                bit_idx += 1;
                            }
                        }
                        Some((path_str, dhash))
                    } else {
                        None
                    }
                })
                .collect();
            Ok(local_hashes)
        })
        .await
        .unwrap_or(Err("Task failed".to_string()));

    let hashes = result?;
    let mut grouped = Vec::new();
    let mut processed = std::collections::HashSet::new();

    for i in 0..hashes.len() {
        if processed.contains(&i) {
            continue;
        }

        let mut current_group = vec![hashes[i].0.clone()];
        processed.insert(i);

        for j in (i + 1)..hashes.len() {
            if processed.contains(&j) {
                continue;
            }
            let diff = (hashes[i].1 ^ hashes[j].1).count_ones();
            if diff <= 10 {
                current_group.push(hashes[j].0.clone());
                processed.insert(j);
            }
        }
        if current_group.len() > 1 {
            grouped.push(current_group);
        }
    }

    Ok(grouped)
}

#[tauri::command]
pub async fn batch_transcode(
    paths: Vec<String>,
    target_format: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let target = target_format.to_lowercase();
    let fmt = match target.as_str() {
        "jpeg" | "jpg" => image::ImageFormat::Jpeg,
        "png" => image::ImageFormat::Png,
        "webp" => image::ImageFormat::WebP,
        "tiff" | "tif" => image::ImageFormat::Tiff,
        "avif" => image::ImageFormat::Avif,
        _ => return Err(format!("Unsupported format: {}", target_format)),
    };

    if paths.is_empty() {
        return Ok("No files selected".to_string());
    }

    for path_str in &paths {
        let p = PathBuf::from(path_str);
        if !crate::is_path_safe(&p, &state) {
            return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
        }
    }

    let count = paths.len();

    let res = tauri::async_runtime::spawn_blocking(move || {
        use rayon::prelude::*;
        let results: Vec<Result<(), String>> = paths
            .par_iter()
            .map(|path_str| {
                let path = std::path::Path::new(path_str);
                if !path.exists() {
                    return Err("File not found".to_string());
                }

                let img = media_core::open_image(path).map_err(|e| e.to_string())?;
                let parent = path.parent().unwrap_or(path);
                let dir = parent.join("Transcoded");
                let _ = std::fs::create_dir_all(&dir);

                let stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("output");
                let ext = match fmt {
                    image::ImageFormat::Jpeg => "jpg",
                    image::ImageFormat::Png => "png",
                    image::ImageFormat::WebP => "webp",
                    image::ImageFormat::Tiff => "tiff",
                    image::ImageFormat::Avif => "avif",
                    _ => "dat",
                };
                let out_path = dir.join(format!("{}.{}", stem, ext));

                let img_rgba8 = image::DynamicImage::ImageRgba8(img.into_rgba8());
                img_rgba8
                    .save_with_format(&out_path, fmt)
                    .map_err(|e| e.to_string())
            })
            .collect();

        let mut success = 0;
        let mut fails = 0;
        let mut last_err = String::new();
        for result in results {
            match result {
                Ok(()) => success += 1,
                Err(e) => {
                    fails += 1;
                    last_err = e;
                }
            }
        }
        (success, fails, last_err)
    })
    .await
    .unwrap_or((0, count, "Thread crashed".to_string()));

    if res.1 > 0 {
        if res.0 == 0 {
            return Err(format!("Transcode failed. Last error: {}", res.2));
        } else {
            return Ok(format!(
                "Transcoded {} files. Failed: {}. Last error: {}",
                res.0, res.1, res.2
            ));
        }
    }

    Ok(format!(
        "Successfully transcoded {} files to {} inside the \"Transcoded\" subfolder!",
        res.0,
        target_format.to_uppercase()
    ))
}

fn base64_encode(data: &[u8]) -> String {
    use std::fmt::Write;
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 {
            chunk[1] as usize
        } else {
            0
        };
        let b2 = if chunk.len() > 2 {
            chunk[2] as usize
        } else {
            0
        };
        let _ = write!(
            out,
            "{}{}{}{}",
            CHARS[b0 >> 2] as char,
            CHARS[((b0 & 3) << 4) | (b1 >> 4)] as char,
            if chunk.len() > 1 {
                CHARS[((b1 & 0xf) << 2) | (b2 >> 6)] as char
            } else {
                '='
            },
            if chunk.len() > 2 {
                CHARS[b2 & 0x3f] as char
            } else {
                '='
            },
        );
    }
    out
}

#[derive(serde::Serialize)]
pub struct UiHistogram {
    pub r: Vec<u32>,
    pub g: Vec<u32>,
    pub b: Vec<u32>,
    pub lum: Vec<u32>,
    pub peak: u32,
}

#[tauri::command]
pub async fn get_visual_histogram(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<UiHistogram>, String> {
    let p = PathBuf::from(&path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
    }
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        match state_arc.cache.get_visual_histogram(&p) {
            Ok(Some((r, g, b, lum))) => {
                let peak = r
                    .iter()
                    .chain(g.iter())
                    .chain(b.iter())
                    .chain(lum.iter())
                    .cloned()
                    .max()
                    .unwrap_or(0);
                Ok(Some(UiHistogram {
                    r: r.to_vec(),
                    g: g.to_vec(),
                    b: b.to_vec(),
                    lum: lum.to_vec(),
                    peak,
                }))
            }
            Ok(None) => {
                // If it doesn't exist, try to compute it from the thumbnail if it exists
                let max_side = 320;
                let thumb_path = state_arc
                    .cache
                    .thumbnail_path(&p, max_side)
                    .unwrap_or_default();
                if thumb_path.exists() {
                    let _ = state_arc.cache.cache_visual_histogram(&p, &thumb_path);
                    if let Ok(Some((r, g, b, lum))) = state_arc.cache.get_visual_histogram(&p) {
                        let peak = r
                            .iter()
                            .chain(g.iter())
                            .chain(b.iter())
                            .chain(lum.iter())
                            .cloned()
                            .max()
                            .unwrap_or(0);
                        return Ok(Some(UiHistogram {
                            r: r.to_vec(),
                            g: g.to_vec(),
                            b: b.to_vec(),
                            lum: lum.to_vec(),
                            peak,
                        }));
                    }
                }
                Ok(None)
            }
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
