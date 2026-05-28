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

    // 2. Brightness (simple linear shift)
    if edit.brightness != 0.0 {
        // Map -100..100 to -255..255
        let amount = (edit.brightness / 100.0 * 255.0) as i32;
        img = img.brighten(amount);
    }

    // 3. Simple Vibrance (Saturation boost)
    if edit.vibrance != 0.0 {
        let mut rgba = img.to_rgba8();
        let sat = edit.vibrance / 100.0;

        for px in rgba.pixels_mut() {
            let [r8, g8, b8, a8] = px.0;
            let r = r8 as f32 / 255.0;
            let g = g8 as f32 / 255.0;
            let b = b8 as f32 / 255.0;

            let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let nr = (lum + (r - lum) * (1.0 + sat)).clamp(0.0, 1.0);
            let ng = (lum + (g - lum) * (1.0 + sat)).clamp(0.0, 1.0);
            let nb = (lum + (b - lum) * (1.0 + sat)).clamp(0.0, 1.0);

            px.0 = [
                (nr * 255.0) as u8,
                (ng * 255.0) as u8,
                (nb * 255.0) as u8,
                a8,
            ];
        }
        img = DynamicImage::ImageRgba8(rgba);
    }

    // 4. Cropping (relative coordinates)
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
