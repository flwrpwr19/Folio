use image::DynamicImage;
use serde::{Deserialize, Serialize};

fn default_one() -> f32 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimpleEdit {
    /// Brightness adjustment: -100 to 100
    pub brightness: f32,
    /// Vibrance adjustment: -100 to 100
    pub vibrance: f32,
    /// Contrast adjustment: -100 to 100
    #[serde(default)]
    pub contrast: f32,
    /// Saturation adjustment: -100 to 100
    #[serde(default)]
    pub saturation: f32,
    /// Exposure adjustment: -100 to 100
    #[serde(default)]
    pub exposure: f32,
    /// Warmth (color temperature): -100 cool .. 100 warm
    #[serde(default)]
    pub warmth: f32,
    pub flip_h: bool,
    pub flip_v: bool,
    #[serde(default)]
    pub rotate: i32,
    #[serde(default)]
    pub crop_x: f32,
    #[serde(default)]
    pub crop_y: f32,
    #[serde(default = "default_one")]
    pub crop_w: f32,
    #[serde(default = "default_one")]
    pub crop_h: f32,
}

impl Default for SimpleEdit {
    fn default() -> Self {
        Self {
            brightness: 0.0,
            vibrance: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            exposure: 0.0,
            warmth: 0.0,
            flip_h: false,
            flip_v: false,
            rotate: 0,
            crop_x: 0.0,
            crop_y: 0.0,
            crop_w: 1.0,
            crop_h: 1.0,
        }
    }
}

impl SimpleEdit {
    pub fn is_identity(&self) -> bool {
        self.brightness == 0.0
            && self.vibrance == 0.0
            && self.contrast == 0.0
            && self.saturation == 0.0
            && self.exposure == 0.0
            && self.warmth == 0.0
            && !self.flip_h
            && !self.flip_v
            && self.rotate == 0
            && self.crop_x == 0.0
            && self.crop_y == 0.0
            && self.crop_w == 1.0
            && self.crop_h == 1.0
    }
}

pub fn apply_edit(image: &DynamicImage, edit: &SimpleEdit) -> DynamicImage {
    if edit.is_identity() {
        return image.clone();
    }

    let mut img = image.clone();

    // 0. Rotation
    if edit.rotate != 0 {
        img = match edit.rotate {
            90 | -270 => img.rotate90(),
            180 | -180 => img.rotate180(),
            270 | -90 => img.rotate270(),
            _ => img,
        };
    }

    // 1. Flipping
    if edit.flip_h {
        img = img.fliph();
    }
    if edit.flip_v {
        img = img.flipv();
    }

    let needs_pixel_pass = edit.exposure != 0.0
        || edit.brightness != 0.0
        || edit.contrast != 0.0
        || edit.saturation != 0.0
        || edit.vibrance != 0.0
        || edit.warmth != 0.0;

    if needs_pixel_pass {
        let mut rgba = img.to_rgba8();
        let exp_mul = 2.0_f32.powf(edit.exposure / 50.0);
        let bright_off = edit.brightness / 100.0;
        let contrast_f = 1.0 + edit.contrast / 100.0;
        let sat_f = 1.0 + edit.saturation / 100.0;
        let vib_f = edit.vibrance / 100.0;
        let warm = edit.warmth / 100.0;

        for px in rgba.pixels_mut() {
            let mut r = px[0] as f32 / 255.0;
            let mut g = px[1] as f32 / 255.0;
            let mut b = px[2] as f32 / 255.0;

            r *= exp_mul;
            g *= exp_mul;
            b *= exp_mul;

            r = (r + bright_off).clamp(0.0, 1.0);
            g = (g + bright_off).clamp(0.0, 1.0);
            b = (b + bright_off).clamp(0.0, 1.0);

            r = ((r - 0.5) * contrast_f + 0.5).clamp(0.0, 1.0);
            g = ((g - 0.5) * contrast_f + 0.5).clamp(0.0, 1.0);
            b = ((b - 0.5) * contrast_f + 0.5).clamp(0.0, 1.0);

            if warm != 0.0 {
                r = (r + warm * 0.12).clamp(0.0, 1.0);
                b = (b - warm * 0.12).clamp(0.0, 1.0);
            }

            let apply_sat = |c: f32, lum: f32, factor: f32| -> f32 {
                (lum + (c - lum) * (1.0 + factor)).clamp(0.0, 1.0)
            };

            if sat_f != 1.0 || vib_f != 0.0 {
                let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                let factor = (sat_f - 1.0) + vib_f;
                r = apply_sat(r, lum, factor);
                g = apply_sat(g, lum, factor);
                b = apply_sat(b, lum, factor);
            }

            px[0] = (r * 255.0).round() as u8;
            px[1] = (g * 255.0).round() as u8;
            px[2] = (b * 255.0).round() as u8;
        }
        img = DynamicImage::ImageRgba8(rgba);
    }

    // Cropping (relative coordinates)
    if edit.crop_x != 0.0 || edit.crop_y != 0.0 || edit.crop_w < 1.0 || edit.crop_h < 1.0 {
        use image::GenericImageView;
        let (w, h) = img.dimensions();
        let cx = (edit.crop_x * w as f32).round() as u32;
        let cy = (edit.crop_y * h as f32).round() as u32;
        let cw = (edit.crop_w * w as f32).round() as u32;
        let ch = (edit.crop_h * h as f32).round() as u32;

        let cx = cx.min(w);
        let cy = cy.min(h);
        let cw = cw.min(w - cx).max(1);
        let ch = ch.min(h - cy).max(1);
        img = img.crop_imm(cx, cy, cw, ch);
    }

    img
}
