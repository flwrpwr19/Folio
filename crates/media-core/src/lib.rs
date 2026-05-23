#![deny(unsafe_code)]
pub mod edit;
pub use edit::{SimpleEdit, apply_edit};

use std::fs::File;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use exif::{In, Reader, Tag};
use image::ImageReader;
use image::{DynamicImage, GenericImageView};
use thiserror::Error;
use walkdir::WalkDir;

#[derive(Debug, Clone, Default)]
pub struct ExifData {
    pub camera: Option<String>,
    pub aperture: Option<String>,
    pub shutter_speed: Option<String>,
    pub iso: Option<String>,
    pub focal_length: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct ImageMetadata {
    pub width: u32,
    pub height: u32,
    pub orientation: u16,
    pub format: Option<image::ImageFormat>,
    pub exif: Option<ExifData>,
    pub focus_score: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("unsupported image format: {0}")]
    Unsupported(PathBuf),
}

pub fn supported_image_extensions() -> &'static [&'static str] {
    &[
        // Browser-native (image crate handles these fine)
        "jpg", "jpeg", "png", "webp", "avif", "gif", "bmp",
        // TIFF — image crate handles basic TIFFs; exotic photometrics fall back to sips
        "tif", "tiff",
        // RAW formats — all handled via sips on macOS
        "raf", "nef", "nrw", "arw", "srf", "sr2", "cr2", "cr3", "crw",
        "orf", "rw2", "pef", "dng", "raw", "rwl", "mrw", "erf", "mos",
        "iiq", "3fr", "fff", "srw", "axr", "dcr", "dxo", "nefx",
        // Other formats sips can read
        "heic", "heif", "heics", "avci",
        "exr", "psd", "jxl", "jp2",
        "svg", "pic", "sgi", "tga", "mpo",
    ]
}

pub fn supported_video_extensions() -> &'static [&'static str] {
    &["mp4", "mov", "mkv", "webm"]
}

pub fn is_supported_media_path(path: &Path) -> bool {
    path.extension()
        .and_then(std::ffi::OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .is_some_and(|ext| {
            supported_image_extensions().contains(&ext.as_str())
                || supported_video_extensions().contains(&ext.as_str())
        })
}

pub fn is_video_path(path: &Path) -> bool {
    path.extension()
        .and_then(std::ffi::OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .is_some_and(|ext| supported_video_extensions().contains(&ext.as_str()))
}

pub fn is_supported_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(std::ffi::OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .is_some_and(|ext| supported_image_extensions().contains(&ext.as_str()))
}

pub fn scan_supported_media(root: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = WalkDir::new(root)
        .follow_links(true)
        .max_depth(1) // Only scan the selected folder, not deep recursion
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(walkdir::DirEntry::into_path)
        .filter(|path| is_supported_media_path(path))
        .collect::<Vec<_>>();
    paths.sort_unstable();
    Ok(paths)
}

// Keep old name for backwards compat
pub fn scan_supported_images(root: &Path) -> Result<Vec<PathBuf>> {
    scan_supported_media(root)
}

/// Formats the `image` crate can decode natively without sips.
fn image_crate_native(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif" | "bmp")
}

pub fn needs_sips_decode(path: &Path) -> bool {
    let ext = path.extension()
        .and_then(std::ffi::OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    // On macOS, we use sips for everything that's not natively handled by the image crate,
    // plus TIFF because the image crate's TIFF decoder is buggy with IFDs and 16-bit.
    !image_crate_native(&ext) || ext == "tif" || ext == "tiff"
}

pub fn can_use_sips(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        let ext = path.extension()
            .and_then(std::ffi::OsStr::to_str)
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        ext != "webp" && ext != "gif" && is_supported_image_path(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Resize any image via macOS `sips` directly to a file. 
/// Used for high-performance thumbnailing and full-size decoding.
#[cfg(target_os = "macos")]
pub fn sips_output_to_file(path: &Path, dest: &Path, max_side: Option<u32>, format: &str) -> Result<()> {
    use std::process::Command;
    let mut cmd = Command::new("sips");
    cmd.arg("-s").arg("format").arg(format);
    
    if format == "jpeg" {
        cmd.arg("-s").arg("formatOptions").arg("95");
    }

    if let Some(max_side) = max_side {
        cmd.arg("-Z").arg(max_side.to_string());
    }

    cmd.arg(path)
       .arg("--out")
       .arg(dest);

    let output = cmd.output().with_context(|| format!("sips failed for {}", path.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("sips error for {}: {}", path.display(), stderr);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn sips_output_to_file(_path: &Path, _dest: &Path, _max_side: Option<u32>, _format: &str) -> Result<()> {
    anyhow::bail!("sips is only available on macOS")
}

/// Decode any image via macOS `sips` → temp JPEG → `image` crate.
/// Used for RAW files, exotic TIFFs, HEIC, EXR, PSD, JXL, etc.
#[cfg(target_os = "macos")]
pub fn sips_decode(path: &Path) -> Result<DynamicImage> {
    use std::process::Command;

    // Include mtime in cache key so edits to the source file invalidate the cache
    let mtime = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cache_key = format!("{}::{}", path.to_string_lossy(), mtime);
    let tmp = std::env::temp_dir().join(format!(
        "folio_sips_{}.jpg",
        blake3::hash(cache_key.as_bytes()).to_hex()
    ));

    if !tmp.exists() {
        let output = Command::new("sips")
            .args(["-s", "format", "jpeg"])
            .args(["-s", "formatOptions", "100"])
            .arg(path)
            .args(["--out", tmp.to_str().context("non-UTF8 temp path")?])
            .output()
            .with_context(|| format!("sips failed for {}", path.display()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("sips error for {}: {}", path.display(), stderr);
        }
    }

    image::open(&tmp).with_context(|| format!("failed to open sips output for {}", path.display()))
}

#[cfg(not(target_os = "macos"))]
pub fn sips_decode(path: &Path) -> Result<DynamicImage> {
    anyhow::bail!("sips is only available on macOS: {}", path.display())
}

/// Get dimensions via macOS `sips` without decoding the whole image.
#[cfg(target_os = "macos")]
pub fn sips_get_dimensions(path: &Path) -> Result<(u32, u32)> {
    use std::process::Command;
    let output = Command::new("sips")
        .args(["-g", "pixelWidth", "-g", "pixelHeight"])
        .arg(path)
        .output()
        .with_context(|| format!("sips -g failed for {}", path.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("sips -g error for {}: {}", path.display(), stderr);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut w = None;
    let mut h = None;

    for line in stdout.lines() {
        if line.contains("pixelWidth:") {
            w = line.split(':').last().and_then(|s| s.trim().parse().ok());
        } else if line.contains("pixelHeight:") {
            h = line.split(':').last().and_then(|s| s.trim().parse().ok());
        }
    }

    match (w, h) {
        (Some(w), Some(h)) => Ok((w, h)),
        _ => anyhow::bail!("failed to parse sips output for {}: {}", path.display(), stdout),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn sips_get_dimensions(_path: &Path) -> Result<(u32, u32)> {
    anyhow::bail!("sips is only available on macOS")
}

/// Open an image, falling back to sips for formats the image crate can't handle.
pub fn open_image(path: &Path) -> Result<DynamicImage> {
    let ext = path.extension()
        .and_then(std::ffi::OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    if image_crate_native(&ext) {
        let reader = ImageReader::open(path)
            .with_context(|| format!("failed to open image file: {}", path.display()))?
            .with_guessed_format()
            .with_context(|| format!("failed to guess format: {}", path.display()))?;
        return reader.decode()
            .with_context(|| format!("failed to decode image: {}", path.display()));
    }

    // On macOS, always use sips for TIFF and everything else non-native.
    // The image crate's TIFF decoder often reads thumbnail IFDs or fails on 16-bit/exotic photometrics.
    #[cfg(target_os = "macos")]
    {
        return sips_decode(path);
    }

    #[cfg(not(target_os = "macos"))]
    {
        // For TIFF, try image crate first (handles most TIFFs), fall back to sips (which will error on non-macOS)
        if ext == "tif" || ext == "tiff" {
            match image::open(path) {
                Ok(img) => return Ok(img),
                Err(_) => return sips_decode(path),
            }
        }
        sips_decode(path)
    }
}

#[cfg(target_os = "macos")]
pub fn get_video_dimensions_macos(path: &Path) -> Option<(u32, u32)> {
    use std::process::Command;
    let output = Command::new("mdls")
        .arg("-name")
        .arg("kMDItemPixelWidth")
        .arg("-name")
        .arg("kMDItemPixelHeight")
        .arg(path)
        .output()
        .ok()?;
        
    if !output.status.success() {
        return None;
    }
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut w = None;
    let mut h = None;
    
    for line in stdout.lines() {
        if line.contains("kMDItemPixelWidth") {
            w = line.split('=').last().and_then(|s| s.trim().parse().ok());
        } else if line.contains("kMDItemPixelHeight") {
            h = line.split('=').last().and_then(|s| s.trim().parse().ok());
        }
    }
    
    match (w, h) {
        (Some(w), Some(h)) => Some((w, h)),
        _ => None,
    }
}

pub fn read_metadata_fast(path: &Path) -> Result<ImageMetadata> {
    if is_video_path(path) {
        let (width, height) = {
            #[cfg(target_os = "macos")]
            {
                get_video_dimensions_macos(path).unwrap_or((1920, 1080))
            }
            #[cfg(not(target_os = "macos"))]
            {
                (1920, 1080)
            }
        };

        return Ok(ImageMetadata {
            width,
            height,
            orientation: 1,
            format: None,
            exif: None,
            focus_score: None,
        });
    }

    if !is_supported_image_path(path) {
        return Err(MediaError::Unsupported(path.to_path_buf()).into());
    }

    let ext = path.extension()
        .and_then(std::ffi::OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    // For image-crate-native formats, try fast header-only dimension read
    let (width, height, format) = if image_crate_native(&ext) {
        let file = std::fs::File::open(path)
            .with_context(|| format!("failed to open image file: {}", path.display()))?;
        let reader = ImageReader::new(std::io::BufReader::new(file))
            .with_guessed_format()
            .with_context(|| format!("failed to guess format: {}", path.display()))?;
        let fmt = reader.format();
        let (w, h) = reader.into_dimensions()
            .with_context(|| format!("failed to read dimensions: {}", path.display()))?;
        (w, h, fmt)
    } else {
        // For everything else (TIFF, RAW, etc.) use sips on macOS for speed and reliability.
        #[cfg(target_os = "macos")]
        {
            let (w, h) = sips_get_dimensions(path)?;
            (w, h, None)
        }
        #[cfg(not(target_os = "macos"))]
        {
            // Fallback for non-macOS if we ever support it (currently we don't for RAW)
            if ext == "tif" || ext == "tiff" {
                let reader = ImageReader::open(path)
                    .ok()
                    .and_then(|r| r.with_guessed_format().ok());
                let fmt = reader.as_ref().and_then(|r| r.format());
                match reader.and_then(|r| r.into_dimensions().ok()) {
                    Some((w, h)) => (w, h, fmt),
                    None => anyhow::bail!("TIFF dimensions failed and sips unavailable"),
                }
            } else {
                anyhow::bail!("RAW formats require sips (macOS only)")
            }
        }
    };

    let (orientation, exif_data) = read_full_exif(path).unwrap_or((1, None));
    Ok(ImageMetadata {
        width,
        height,
        orientation,
        format,
        exif: exif_data,
        focus_score: None,
    })
}

pub fn read_metadata(path: &Path) -> Result<ImageMetadata> {
    read_metadata_fast(path)
}

pub fn decode_image(path: &Path, max_side: Option<u32>) -> Result<DecodedImage> {
    let mut img = open_image(path)?;
    let orientation = read_exif_orientation(path).unwrap_or(1);
    img = apply_orientation(img, orientation);

    if let Some(max_side) = max_side {
        img = downscale_if_needed(img, max_side);
    }

    let rgba8 = img.to_rgba8();
    let (width, height) = img.dimensions();
    Ok(DecodedImage { width, height, rgba: rgba8.into_vec() })
}

/// Decode image with a pre-known orientation value, skipping EXIF re-read.
pub fn decode_image_with_orientation(path: &Path, max_side: Option<u32>, orientation: u16) -> Result<DecodedImage> {
    let mut img = open_image(path)?;
    img = apply_orientation(img, orientation);

    if let Some(max_side) = max_side {
        img = downscale_if_needed(img, max_side);
    }

    let rgba8 = img.to_rgba8();
    let (width, height) = img.dimensions();
    Ok(DecodedImage { width, height, rgba: rgba8.into_vec() })
}

fn downscale_if_needed(image: DynamicImage, max_side: u32) -> DynamicImage {
    use fast_image_resize::IntoImageView;

    let (width, height) = image.dimensions();
    let current_max = width.max(height);
    if current_max <= max_side || max_side == 0 {
        return image;
    }

    let scale = max_side as f32 / current_max as f32;
    let target_w = (width as f32 * scale).round().max(1.0) as u32;
    let target_h = (height as f32 * scale).round().max(1.0) as u32;

    let src_view = &image;
    let pixel_type = match src_view.pixel_type() {
        Some(t) => t,
        None => return image.resize(target_w, target_h, image::imageops::FilterType::Lanczos3),
    };

    let mut dst_image = fast_image_resize::images::Image::new(
        target_w,
        target_h,
        pixel_type,
    );

    let mut resizer = fast_image_resize::Resizer::new();
    let mut options = fast_image_resize::ResizeOptions::default();
    options.algorithm = fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Lanczos3);

    if resizer.resize(src_view, &mut dst_image, Some(&options)).is_ok() {
        let buffer = dst_image.into_vec();
        match pixel_type {
            fast_image_resize::PixelType::U8x4 => {
                if let Some(buf) = image::RgbaImage::from_raw(target_w, target_h, buffer) {
                    return DynamicImage::ImageRgba8(buf);
                }
            }
            fast_image_resize::PixelType::U8x3 => {
                if let Some(buf) = image::RgbImage::from_raw(target_w, target_h, buffer) {
                    return DynamicImage::ImageRgb8(buf);
                }
            }
            fast_image_resize::PixelType::U8 => {
                if let Some(buf) = image::GrayImage::from_raw(target_w, target_h, buffer) {
                    return DynamicImage::ImageLuma8(buf);
                }
            }
            _ => {}
        }
    }

    image.resize(target_w, target_h, image::imageops::FilterType::Lanczos3)

}

fn read_exif_orientation(path: &Path) -> Result<u16> {
    let (orientation, _) = read_full_exif(path)?;
    Ok(orientation)
}

fn read_full_exif(path: &Path) -> Result<(u16, Option<ExifData>)> {
    let file = File::open(path)?;
    let mut reader = std::io::BufReader::new(file);
    let exif = match Reader::new().read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return Ok((1, None)),
    };

    let orientation = exif
        .get_field(Tag::Orientation, In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .map(|v| v as u16)
        .unwrap_or(1);

    let camera = exif
        .get_field(Tag::Model, In::PRIMARY)
        .map(|f| f.display_value().with_unit(&exif).to_string());
    
    let aperture = exif
        .get_field(Tag::FNumber, In::PRIMARY)
        .map(|f| f.display_value().with_unit(&exif).to_string());
    
    let shutter_speed = exif
        .get_field(Tag::ExposureTime, In::PRIMARY)
        .map(|f| f.display_value().with_unit(&exif).to_string());

    let iso = exif
        .get_field(Tag::PhotographicSensitivity, In::PRIMARY)
        .map(|f| f.display_value().with_unit(&exif).to_string());

    let focal_length = exif
        .get_field(Tag::FocalLength, In::PRIMARY)
        .map(|f| f.display_value().with_unit(&exif).to_string());

    let parse_gps_coord = |tag: Tag, ref_tag: Tag| -> Option<f64> {
        let field = exif.get_field(tag, In::PRIMARY)?;
        let ref_field = exif.get_field(ref_tag, In::PRIMARY)?;
        let ref_val = ref_field.display_value().to_string();
        
        if let exif::Value::Rational(rationals) = &field.value {
            if rationals.len() >= 3 {
                let d = rationals[0].num as f64 / rationals[0].denom.max(1) as f64;
                let m = rationals[1].num as f64 / rationals[1].denom.max(1) as f64;
                let s = rationals[2].num as f64 / rationals[2].denom.max(1) as f64;
                let mut val = d + (m / 60.0) + (s / 3600.0);
                let ref_upper = ref_val.to_uppercase();
                if ref_upper.contains("S") || ref_upper.contains("W") {
                    val = -val;
                }
                Some(val)
            } else {
                None
            }
        } else {
            None
        }
    };

    let latitude = parse_gps_coord(Tag::GPSLatitude, Tag::GPSLatitudeRef);
    let longitude = parse_gps_coord(Tag::GPSLongitude, Tag::GPSLongitudeRef);

    let has_exif = camera.is_some() || aperture.is_some() || shutter_speed.is_some() || iso.is_some() || focal_length.is_some() || latitude.is_some() || longitude.is_some();
    
    let exif_data = if has_exif {
        Some(ExifData {
            camera,
            aperture,
            shutter_speed,
            iso,
            focal_length,
            latitude,
            longitude,
        })
    } else {
        None
    };

    Ok((orientation, exif_data))
}

/// Decode and apply EXIF orientation to an already-opened DynamicImage.
pub fn apply_exif_orientation(image: &DynamicImage, path: &Path) -> DynamicImage {
    let orientation = read_exif_orientation(path).unwrap_or(1);
    apply_orientation(image.clone(), orientation)
}

/// Apply a known orientation value to an already-opened DynamicImage.
/// Use this when orientation is already available (e.g. from ImageMetadata) to avoid re-reading EXIF.
pub fn apply_orientation_value(image: DynamicImage, orientation: u16) -> DynamicImage {
    apply_orientation(image, orientation)
}

pub fn apply_orientation(image: DynamicImage, orientation: u16) -> DynamicImage {
    match orientation {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.rotate90().fliph(),
        6 => image.rotate90(),
        7 => image.rotate270().fliph(),
        8 => image.rotate270(),
        _ => image,
    }
}

pub fn extract_dominant_colors(img: &DynamicImage, count: usize) -> Vec<String> {
    let small = img.resize_exact(32, 32, image::imageops::FilterType::Nearest);
    let rgb = small.to_rgb8();
    
    let pixels: Vec<[f32; 3]> = rgb.pixels().map(|p| {
        [p[0] as f32, p[1] as f32, p[2] as f32]
    }).collect();
    
    if pixels.is_empty() {
        return vec!["#000000".to_string(); count];
    }
    
    // k-means++ initialization
    let mut centroids = Vec::with_capacity(count);
    let mut distances = vec![f32::MAX; pixels.len()];
    
    // First centroid: random-ish pick (use first pixel for determinism)
    centroids.push(pixels[0]);
    
    for _ in 1..count {
        // Update distances to nearest centroid
        let last = &centroids[centroids.len() - 1];
        let mut total = 0.0f32;
        for (i, &pixel) in pixels.iter().enumerate() {
            let dist = (pixel[0] - last[0]).powi(2)
                + (pixel[1] - last[1]).powi(2)
                + (pixel[2] - last[2]).powi(2);
            distances[i] = distances[i].min(dist);
            total += distances[i];
        }
        
        // Pick next centroid with probability proportional to distance²
        if total <= 0.0 {
            centroids.push(pixels[pixels.len() / 2]);
        } else {
            let target = (pixels.len() as f32 / (count as f32)) * total / pixels.len() as f32;
            let mut accum = 0.0f32;
            let mut chosen = pixels.len() - 1;
            for (i, &d) in distances.iter().enumerate() {
                accum += d;
                if accum >= target {
                    chosen = i;
                    break;
                }
            }
            centroids.push(pixels[chosen]);
        }
    }
    
    let mut assignments = vec![0; pixels.len()];
    let mut cluster_sums = vec![[0.0f32; 3]; count];
    let mut cluster_counts = vec![0; count];
    
    for _ in 0..10 {
        cluster_sums.fill([0.0, 0.0, 0.0]);
        cluster_counts.fill(0);
        
        for (p_idx, &pixel) in pixels.iter().enumerate() {
            let mut best_centroid = 0;
            let mut best_dist = f32::MAX;
            for (c_idx, &centroid) in centroids.iter().enumerate() {
                let dist = (pixel[0] - centroid[0]).powi(2)
                    + (pixel[1] - centroid[1]).powi(2)
                    + (pixel[2] - centroid[2]).powi(2);
                if dist < best_dist {
                    best_dist = dist;
                    best_centroid = c_idx;
                }
            }
            assignments[p_idx] = best_centroid;
            cluster_sums[best_centroid][0] += pixel[0];
            cluster_sums[best_centroid][1] += pixel[1];
            cluster_sums[best_centroid][2] += pixel[2];
            cluster_counts[best_centroid] += 1;
        }
        
        let mut converged = true;
        for c_idx in 0..count {
            let len = cluster_counts[c_idx] as f32;
            if len > 0.0 {
                let new_centroid = [
                    cluster_sums[c_idx][0] / len,
                    cluster_sums[c_idx][1] / len,
                    cluster_sums[c_idx][2] / len,
                ];
                let shift = (new_centroid[0] - centroids[c_idx][0]).powi(2)
                    + (new_centroid[1] - centroids[c_idx][1]).powi(2)
                    + (new_centroid[2] - centroids[c_idx][2]).powi(2);
                if shift > 1.0 {
                    converged = false;
                }
                centroids[c_idx] = new_centroid;
            }
        }
        if converged {
            break;
        }
    }
    
    let mut hex_colors = Vec::new();
    for centroid in centroids {
        let r = centroid[0].clamp(0.0, 255.0) as u8;
        let g = centroid[1].clamp(0.0, 255.0) as u8;
        let b = centroid[2].clamp(0.0, 255.0) as u8;
        hex_colors.push(format!("#{:02x}{:02x}{:02x}", r, g, b));
    }
    
    hex_colors.sort();
    hex_colors.dedup();
    while hex_colors.len() < count {
        hex_colors.push("#000000".to_string());
    }
    hex_colors.truncate(count);
    hex_colors
}

pub fn compute_histogram_from_image(img: &image::DynamicImage) -> ([u32; 256], [u32; 256], [u32; 256], [u32; 256]) {
    let mut r = [0u32; 256];
    let mut g = [0u32; 256];
    let mut b = [0u32; 256];
    let mut lum = [0u32; 256];

    if let Some(rgb) = img.as_rgb8() {
        for pixel in rgb.pixels() {
            let pr = pixel[0] as usize;
            let pg = pixel[1] as usize;
            let pb = pixel[2] as usize;
            r[pr] += 1;
            g[pg] += 1;
            b[pb] += 1;
            let l = (0.299 * pixel[0] as f32 + 0.587 * pixel[1] as f32 + 0.114 * pixel[2] as f32) as usize;
            lum[l.min(255)] += 1;
        }
    } else if let Some(rgba) = img.as_rgba8() {
        for pixel in rgba.pixels() {
            let pr = pixel[0] as usize;
            let pg = pixel[1] as usize;
            let pb = pixel[2] as usize;
            r[pr] += 1;
            g[pg] += 1;
            b[pb] += 1;
            let l = (0.299 * pixel[0] as f32 + 0.587 * pixel[1] as f32 + 0.114 * pixel[2] as f32) as usize;
            lum[l.min(255)] += 1;
        }
    } else {
        let rgb = img.to_rgb8();
        for pixel in rgb.pixels() {
            let pr = pixel[0] as usize;
            let pg = pixel[1] as usize;
            let pb = pixel[2] as usize;
            r[pr] += 1;
            g[pg] += 1;
            b[pb] += 1;
            let l = (0.299 * pixel[0] as f32 + 0.587 * pixel[1] as f32 + 0.114 * pixel[2] as f32) as usize;
            lum[l.min(255)] += 1;
        }
    }

    (r, g, b, lum)
}

pub fn detect_focus_blur(img: &DynamicImage) -> f64 {
    let scaled = if img.width() > 640 || img.height() > 640 {
        img.thumbnail(640, 640)
    } else {
        img.clone()
    };
    
    let gray = scaled.to_luma8();
    let width = gray.width() as usize;
    let height = gray.height() as usize;
    
    if width < 3 || height < 3 {
        return 0.0;
    }
    
    let raw = gray.as_raw();
    let mut sum = 0.0;
    let mut count = 0;
    
    let mut laplacians = Vec::with_capacity((width - 2) * (height - 2));
    
    for y in 1..(height - 1) {
        let prev_idx = (y - 1) * width;
        let curr_idx = y * width;
        let next_idx = (y + 1) * width;
        
        for x in 1..(width - 1) {
            let p_top = raw[prev_idx + x] as i32;
            let p_left = raw[curr_idx + x - 1] as i32;
            let p_center = raw[curr_idx + x] as i32;
            let p_right = raw[curr_idx + x + 1] as i32;
            let p_bottom = raw[next_idx + x] as i32;
            
            let lap = p_top + p_left - 4 * p_center + p_right + p_bottom;
            let lap_f = lap as f64;
            sum += lap_f;
            laplacians.push(lap_f);
            count += 1;
        }
    }
    
    if count == 0 {
        return 0.0;
    }
    
    let mean = sum / (count as f64);
    let mut variance_sum = 0.0;
    
    for &lap in &laplacians {
        let diff = lap - mean;
        variance_sum += diff * diff;
    }
    
    variance_sum / (count as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_extensions() {
        assert!(is_supported_image_path(Path::new("a.JPG")));
        assert!(is_supported_image_path(Path::new("a.avif")));
        assert!(!is_supported_image_path(Path::new("a.txt")));
    }

    #[test]
    fn detects_video_extensions() {
        assert!(is_video_path(Path::new("a.mp4")));
        assert!(is_video_path(Path::new("a.MOV")));
        assert!(!is_video_path(Path::new("a.jpg")));
    }

    #[test]
    fn detects_supported_media() {
        assert!(is_supported_media_path(Path::new("a.jpg")));
        assert!(is_supported_media_path(Path::new("a.mp4")));
        assert!(!is_supported_media_path(Path::new("a.txt")));
    }

    #[test]
    fn rotates_for_orientation_6() {
        let image = DynamicImage::new_rgba8(100, 50);
        let rotated = apply_orientation(image, 6);
        assert_eq!(rotated.dimensions(), (50, 100));
    }
}
