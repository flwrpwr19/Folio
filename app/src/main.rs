//! Folio: a fast, folder-based photo viewer built with Rune.
//!
//! `cargo run -p folio -- /path/to/photos`
//!
//! Ethereal Glass world: OLED-black ground with ambient glow orbs, glass
//! chrome, Space Grotesk typography. Launch lands on the projected slide; Esc
//! opens the bento index. Scan and decode run on worker threads; thumbnails
//! are cached on disk; the viewer's zoom/pan is a Live camera.

mod decode;
mod pipeline;
mod state;
mod view;

use rune::{AppSpec, Chrome, WindowOptions};

fn main() {
    let app = rune::App::new(AppSpec::<state::State> {
        // Space Grotesk (OFL) drives the identity; ui-monospace for numerals.
        fonts: &[include_bytes!("../assets/SpaceGrotesk.ttf")],
        families: ("Space Grotesk", "ui-monospace"),
        setup: Some(state::setup),
        poll: Some(state::poll),
        on_key: Some(state::on_key),
        ..AppSpec::new("Folio", (1360.0, 880.0), state::state, view::view)
    })
    // The slide is the chrome: content fills the window, the traffic lights
    // float over projection black, and only marked regions drag.
    .chrome(Chrome {
        full_size_content: true,
        traffic_lights: Some((20.0, 20.0)),
        drag_regions: true,
    })
    .window_options(WindowOptions { min_size: Some((920.0, 600.0)), ..Default::default() });
    app.run();
}
