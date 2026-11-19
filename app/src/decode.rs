//! Image decode chain. Everything funnels into `decode_scaled(path, max_px)`
//! which returns RGBA8 with EXIF orientation applied.
//!
//! 1. macOS ImageIO (hardware-accelerated, scaled decode, orientation applied):
//!    JPEG, PNG, HEIC/HEIF, TIFF, GIF, WebP, BMP, AVIF and camera RAW previews.
//! 2. `image` crate (cross-platform fallback + exotic formats).
//! 3. `jxl-oxide` for JPEG XL.

use std::io::Cursor;
use std::path::Path;

use image::DynamicImage;

pub struct Decoded {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Decode an image scaled so its long edge is at most `max_px`.
pub fn decode_scaled(path: &Path, max_px: u32) -> Option<Decoded> {
    #[cfg(target_os = "macos")]
    if let Some(decoded) = imageio::decode(path, max_px) {
        return Some(decoded);
    }

    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("jxl"))
        .unwrap_or(false)
    {
        return jxl::decode(path, max_px);
    }

    image_crate::decode(path, max_px)
}

/// Downscale so the long edge is at most `max_px` (no-op when already smaller).
/// `u32::MAX` skips downscaling entirely.
fn downscale(image: &DynamicImage, max_px: u32) -> Option<DynamicImage> {
    if max_px == u32::MAX {
        return None;
    }
    let (w, h) = (image.width(), image.height());
    if w <= max_px && h <= max_px {
        return None;
    }
    Some(if w >= h {
        image.thumbnail(max_px, u32::MAX)
    } else {
        image.thumbnail(u32::MAX, max_px)
    })
}

#[cfg(target_os = "macos")]
mod imageio {
    use super::Decoded;
    use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFType, CFURL};
    use objc2_core_graphics::{CGDataProvider, CGImage, CGImageAlphaInfo};
    use objc2_image_io::{
        CGImageSource, kCGImageSourceCreateThumbnailFromImageAlways,
        kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceThumbnailMaxPixelSize,
    };
    use std::path::Path;

    pub fn decode(path: &Path, max_px: u32) -> Option<Decoded> {
        unsafe {
            let url = CFURL::from_file_path(path)?;
            let source = CGImageSource::with_url(&url, None)?;

            let key_from_always: &CFType = kCGImageSourceCreateThumbnailFromImageAlways.as_ref();
            let key_transform: &CFType = kCGImageSourceCreateThumbnailWithTransform.as_ref();
            let key_max_px: &CFType = kCGImageSourceThumbnailMaxPixelSize.as_ref();
            let yes: &CFType = CFBoolean::new(true).as_ref();
            let number = CFNumber::new_i32(max_px as i32);
            let number: &CFType = (&number).as_ref();

            let dict = CFDictionary::from_slices(
                &[key_from_always, key_transform, key_max_px],
                &[yes, yes, number],
            );
            // CFDictionary<K, V> is ABI-identical to the untyped `CFDictionary`.
            let options: &CFDictionary = std::mem::transmute(&*dict);

            let cg = source.thumbnail_at_index(0, Some(options))?;

            let width = CGImage::width(Some(&cg)) as u32;
            let height = CGImage::height(Some(&cg)) as u32;
            if width == 0 || height == 0 {
                return None;
            }

            let provider = CGImage::data_provider(Some(&cg))?;
            let data = CGDataProvider::data(Some(&provider))?;
            let bytes = data.to_vec();
            let bpr = CGImage::bytes_per_row(Some(&cg));
            let bpp = CGImage::bits_per_pixel(Some(&cg)) as usize;
            let alpha = CGImage::alpha_info(Some(&cg));
            let bitmap_order = cg_bitmap_byte_order(&cg);

            let rgba = to_rgba(&bytes, width, height, bpr, bpp, alpha, bitmap_order)?;

            // ImageIO already honoured max_px, but some formats ignore it.
            let image = match image::RgbaImage::from_raw(width, height, rgba) {
                Some(img) => {
                    let img = image::DynamicImage::ImageRgba8(img);
                    if width > max_px || height > max_px {
                        img.thumbnail(max_px, max_px).into_rgba8()
                    } else {
                        img.into_rgba8()
                    }
                }
                None => return None,
            };
            let (width, height) = (image.width(), image.height());
            Some(Decoded { width, height, rgba: image.into_raw() })
        }
    }

    fn cg_bitmap_byte_order(cg: &CGImage) -> u32 {
        // kCGBitmapByteOrder32Little == 3 << 12; avoid depending on the
        // CGBitmapInfo helper surface.
        unsafe extern "C-unwind" {
            fn CGImageGetBitmapInfo(image: Option<&CGImage>) -> u32;
        }
        unsafe { CGImageGetBitmapInfo(Some(cg)) >> 12 & 0x3 }
    }

    fn to_rgba(
        bytes: &[u8],
        width: u32,
        height: u32,
        bpr: usize,
        bpp: usize,
        alpha: CGImageAlphaInfo,
        order: u32,
    ) -> Option<Vec<u8>> {
        let (width, height) = (width as usize, height as usize);
        let premultiplied =
            alpha == CGImageAlphaInfo::PremultipliedLast || alpha == CGImageAlphaInfo::PremultipliedFirst;
        let alpha_first =
            alpha == CGImageAlphaInfo::First || alpha == CGImageAlphaInfo::PremultipliedFirst;

        let mut rgba = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            let row = bytes.get(y * bpr..)?;
            for x in 0..width {
                let px = row.get(x * bpp / 8..)?;
                // CG pixel words store channels per alpha position; a
                // little-endian word reverses that byte order in memory.
                // Both little-endian cases land on memory B,G,R,A.
                let (r, g, b, a) = match bpp {
                    32 => match (order == 3, alpha_first) {
                        // BGRA in memory
                        (true, _) => (px[2], px[1], px[0], px[3]),
                        // RGBA in memory
                        (false, false) => (px[0], px[1], px[2], px[3]),
                        // ARGB in memory
                        (false, true) => (px[1], px[2], px[3], px[0]),
                    },
                    24 => (px[0], px[1], px[2], 255),
                    8 => (px[0], px[0], px[0], 255),
                    _ => return None,
                };
                let (r, g, b) = if premultiplied && a > 0 && a < 255 {
                    (
                        ((r as u32 * 255) / a as u32) as u8,
                        ((g as u32 * 255) / a as u32) as u8,
                        ((b as u32 * 255) / a as u32) as u8,
                    )
                } else {
                    (r, g, b)
                };
                rgba.extend_from_slice(&[r, g, b, a]);
            }
        }
        Some(rgba)
    }
}

mod jxl {
    use super::Decoded;
    use jxl_oxide::JxlImage;
    use std::path::Path;

    pub fn decode(path: &Path, max_px: u32) -> Option<Decoded> {
        let image = JxlImage::builder().open(path).ok()?;
        let render = image.render_frame(0).ok()?;
        let fb = render.image_all_channels();
        let (w, h) = (fb.width(), fb.height());
        let ch = fb.channels();
        if w == 0 || h == 0 {
            return None;
        }
        let samples = fb.buf();
        let mut rgba = Vec::with_capacity(w * h * 4);
        for pixel in 0..w * h {
            let px = &samples[pixel * ch..pixel * ch + ch];
            let (r, g, b, a) = match ch {
                1 => (px[0], px[0], px[0], 1.0),
                2 => (px[0], px[0], px[0], px[1]),
                3 => (px[0], px[1], px[2], 1.0),
                4 => (px[0], px[1], px[2], px[3]),
                5 => (
                    (1.0 - px[0]) * (1.0 - px[3]),
                    (1.0 - px[1]) * (1.0 - px[3]),
                    (1.0 - px[2]) * (1.0 - px[3]),
                    px[4],
                ),
                _ => return None,
            };
            rgba.extend_from_slice(&[
                (r.clamp(0.0, 1.0) * 255.0).round() as u8,
                (g.clamp(0.0, 1.0) * 255.0).round() as u8,
                (b.clamp(0.0, 1.0) * 255.0).round() as u8,
                (a.clamp(0.0, 1.0) * 255.0).round() as u8,
            ]);
        }
        let image = match image::RgbaImage::from_raw(w as u32, h as u32, rgba) {
            Some(img) => {
                let img = image::DynamicImage::ImageRgba8(img);
                if w as u32 > max_px || h as u32 > max_px {
                    img.thumbnail(max_px, max_px).into_rgba8()
                } else {
                    img.into_rgba8()
                }
            }
            None => return None,
        };
        let (width, height) = (image.width(), image.height());
        Some(Decoded { width, height, rgba: image.into_raw() })
    }
}

mod image_crate {
    use super::{Decoded, downscale};
    use image::{DynamicImage, ImageDecoder, ImageReader};
    use std::path::Path;

    pub fn decode(path: &Path, max_px: u32) -> Option<Decoded> {
        let mut decoder = ImageReader::open(path).ok()?.with_guessed_format().ok()?.into_decoder().ok()?;
        let orientation = decoder
            .orientation()
            .ok()
            .unwrap_or(image::metadata::Orientation::NoTransforms);
        let mut image = DynamicImage::from_decoder(decoder).ok()?;
        image.apply_orientation(orientation);
        if let Some(scaled) = downscale(&image, max_px) {
            image = scaled;
        }
        let rgba = image.to_rgba8();
        let (width, height) = (rgba.width(), rgba.height());
        Some(Decoded { width, height, rgba: rgba.into_raw() })
    }
}

/// Encode an RGBA thumbnail to JPEG bytes for the on-disk cache.
pub fn encode_jpeg(width: u32, height: u32, rgba: Vec<u8>) -> Option<Vec<u8>> {
    let image = image::RgbaImage::from_raw(width, height, rgba)?;
    let rgb = image::DynamicImage::ImageRgba8(image).to_rgb8();
    let mut out = Cursor::new(Vec::with_capacity(64 * 1024));
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 88)
        .encode_image(&rgb)
        .ok()?;
    Some(out.into_inner())
}

pub fn decode_jpeg(bytes: &[u8]) -> Option<Decoded> {
    let image = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).ok()?;
    let rgba = image.to_rgba8();
    let (width, height) = (rgba.width(), rgba.height());
    Some(Decoded { width, height, rgba: rgba.into_raw() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_solid_png(path: &std::path::Path, color: [u8; 3]) {
        let mut img = image::RgbaImage::new(4, 4);
        for px in img.pixels_mut() {
            *px = image::Rgba([color[0], color[1], color[2], 255]);
        }
        img.save(path).unwrap();
    }

    #[test]
    fn imageio_preserves_channel_order_and_scales() {
        let dir = std::env::temp_dir().join("folio-decode-test");
        std::fs::create_dir_all(&dir).unwrap();
        for (name, color) in [
            ("red.png", [255u8, 0, 0]),
            ("green.png", [0, 255, 0]),
            ("blue.png", [0, 0, 255]),
        ] {
            write_solid_png(&dir.join(name), color);
        }

        let red = decode_scaled(&dir.join("red.png"), 512).expect("decode red");
        assert_eq!(&red.rgba[0..4], &[255, 0, 0, 255], "red stays red");

        let green = decode_scaled(&dir.join("green.png"), 512).expect("decode green");
        assert_eq!(&green.rgba[0..4], &[0, 255, 0, 255], "green stays green");

        let blue = decode_scaled(&dir.join("blue.png"), 512).expect("decode blue");
        assert_eq!(&blue.rgba[0..4], &[0, 0, 255, 255], "blue stays blue");

        let big = write_solid_png(&dir.join("big.png"), [10, 20, 30]);
        let _ = big;
        // 4096x4096 source scales to 512 long edge
        let mut img = image::RgbaImage::new(4096, 2048);
        for px in img.pixels_mut() {
            *px = image::Rgba([10, 20, 30, 255]);
        }
        img.save(dir.join("wide.png")).unwrap();
        let scaled = decode_scaled(&dir.join("wide.png"), 512).expect("decode wide");
        assert!(scaled.width <= 512 && scaled.height <= 512, "long edge bounded");
        assert_eq!(&scaled.rgba[0..4], &[10, 20, 30, 255]);
    }
}
