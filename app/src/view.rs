//! The Folio view — Ethereal Glass: OLED-black ground, ambient glow orbs,
//! glass chrome with hairline white/10 edges, double-bezel cards, Space
//! Grotesk type. Index is a bento hero + captioned grid; Slide is cinematic.

use rune::oklcha;
use rune::{
    Color, Cx, El, GrowthSpec, ScrollSpec, SurfaceFit, TextStyle, Transition, Tx, col, el, row, text,
};

use crate::state::{Mode, State};

const SIDEBAR: f32 = 224.0;
const BAR: f32 = 56.0;
const COLS: usize = 5;
const CELL: f32 = 238.0;
const IMG_H: f32 = 172.0;
const GAP: f32 = 14.0;
const HERO_H: f32 = 268.0;
const TRAY: f32 = 106.0;
const TRAY_W: f32 = 116.0;
const TRAY_H: f32 = 74.0;

/* --------------------------------- Tokens --------------------------------- */

fn rgba(r: f32, g: f32, b: f32, a: f32) -> Color {
    Color { r, g, b, a }
}

/// OLED ground.
fn bg() -> Color {
    rgba(0.02, 0.02, 0.022, 1.0)
}

/// Vantablack card fill.
fn glass() -> Color {
    rgba(1.0, 1.0, 1.0, 0.035)
}

fn hairline() -> Color {
    rgba(1.0, 1.0, 1.0, 0.10)
}

fn ink() -> Color {
    rgba(1.0, 1.0, 1.0, 0.95)
}

fn ink_2() -> Color {
    rgba(1.0, 1.0, 1.0, 0.58)
}


/// The accent: violet from the ambient orb.
fn accent() -> Color {
    oklcha(0.68, 0.17, 290.0, 1.0)
}

fn numerals(size: f32, weight: f32) -> TextStyle {
    TextStyle::new(size, weight).features("'tnum' 1")
}

/// An eyebrow pill: a microscopic uppercase badge preceding major content.
fn pill(label: &str) -> El {
    el().radius(999.0).px(10.0).h(22.0).center_y()
        .fill(rgba(1.0, 1.0, 1.0, 0.05))
        .border(1.0, hairline())
        .child(
            text(label.to_uppercase()).font(TextStyle::new(9.5, 650.0))
                .color(rgba(1.0, 1.0, 1.0, 0.62)),
        )
}

/// Glass pill button with the nested trailing arrow circle.
fn glass_action(label: &'static str) -> El {
    el().radius(999.0).h(32.0).pl(14.0).pr(5.0).gap(9.0).center_y()
        .fill(rgba(0.04, 0.04, 0.05, 0.72))
        .backdrop_blur(10.0)
        .border(1.0, hairline())
        .hover(rgba(1.0, 1.0, 1.0, 0.1))
        .press_scale(0.97)
        .child(text(label.to_string()).font(TextStyle::new(12.0, 550.0)).color(rgba(1.0, 1.0, 1.0, 0.88)))
        .child(
            el().size(22.0, 22.0).radius(11.0).center()
                .fill(rgba(1.0, 1.0, 1.0, 0.10))
                .child(text("\u{2197}".to_string()).font(TextStyle::new(11.0, 600.0)).color(rgba(1.0, 1.0, 1.0, 0.85))),
        )
}

fn choose_folder(tx: &mut Tx) {
    tx.open_folder(
        rune::FileDialogOptions { title: "Choose a photo folder".into(), ..Default::default() },
        |s: &mut State, result, _| {
            if let Ok(Some(dir)) = result {
                s.launch_scan(dir);
            }
        },
    );
}

pub fn view(s: &State, _cx: &mut Cx<State>) -> El {
    // Ambient glow orbs live on the root, under everything.
    let mut root = col().key("root").w_full().h_full().fill(bg())
        .on_drop_files(|s: &mut State, files, _| {
            if let Some(folder) = files.iter().find(|f| f.is_dir()) {
                s.launch_scan(folder.clone());
            }
        })
        .child(
            el().key("orb-violet").absolute(-180.0, -240.0).size(760.0, 760.0)
                .radial_gradient(
                    [0.5, 0.5],
                    380.0,
                    [(0.0, oklcha(0.62, 0.20, 285.0, 0.16)), (1.0, oklcha(0.62, 0.20, 285.0, 0.0))],
                ),
        )
        .child(
            el().key("orb-emerald").absolute(-100.0, 520.0).size(680.0, 680.0)
                .radial_gradient(
                    [0.5, 0.5],
                    340.0,
                    [(0.0, oklcha(0.72, 0.15, 165.0, 0.11)), (1.0, oklcha(0.72, 0.15, 165.0, 0.0))],
                ),
        );

    match s.mode {
        Mode::Slide => root = root.child(slide(s)),
        Mode::Index => root = root.child(index(s)),
    }
    root
}

/* ---------------------------------- Index --------------------------------- */

fn index(s: &State) -> El {
    row().key("index").w_full().h_full()
        .transition(Transition::scale(0.985))
        .child(sidebar(s))
        .child(el().key("side-sep").w(1.0).h_full().fill(hairline()))
        .child(main(s))
}

fn sidebar(s: &State) -> El {
    let active = s
        .folder
        .as_ref()
        .map(|f| {
            f.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| f.display().to_string())
        })
        .unwrap_or_else(|| "No folder".into());
    col().key("sidebar").w(SIDEBAR).h_full().fill(rgba(1.0, 1.0, 1.0, 0.025))
        // Traffic lights live over the sidebar; content starts below them.
        .pt(60.0).px(14.0).gap(20.0)
        .window_drag()
        .child(text("Folio").font(TextStyle::new(18.0, 700.0)).color(ink()))
        .child(
            col().gap(6.0)
                .child(pill("Library").px(8.0))
                .child(
                    el().key("nav-browse").radius(12.0).h(38.0).px(10.0).center_y().gap(9.0)
                        .fill(rgba(1.0, 1.0, 1.0, 0.09))
                        .border(1.0, rgba(1.0, 1.0, 1.0, 0.07))
                        .child(el().size(9.0, 9.0).radius(5.0).fill(accent()))
                        .child(text("All Photos".to_string()).font(TextStyle::new(13.0, 550.0)).color(ink()).grow(1.0))
                        .child(text(if s.items.is_empty() { "\u{2014}".into() } else { format!("{}", s.items.len()) })
                            .font(numerals(11.5, 550.0)).color(rgba(1.0, 1.0, 1.0, 0.5))),
                ),
        )
        .child(
            col().gap(6.0)
                .child(pill("Folder").px(8.0))
                .child(
                    el().key("nav-folder").radius(12.0).h(38.0).px(10.0).center_y().gap(9.0)
                        .hover(rgba(1.0, 1.0, 1.0, 0.06))
                        .press_scale(0.98)
                        .on_press_tx(|_s: &mut State, tx: &mut Tx| choose_folder(tx))
                        .child(el().size(9.0, 9.0).radius(5.0).fill(rgba(1.0, 1.0, 1.0, 0.4)))
                        .child(text(active).font(TextStyle::new(13.0, 500.0)).color(rgba(1.0, 1.0, 1.0, 0.82)).grow(1.0).truncate()),
                ),
        )
        .child(el().key("side-grow").grow(1.0))
        .child(
            col().key("sidebar-status").px(10.0).pb(14.0).gap(3.0)
                .child(text(s.status.clone()).font(numerals(11.0, 500.0)).color(rgba(1.0, 1.0, 1.0, 0.5)))
                .child(text("Drop a folder to browse it".to_string()).font(TextStyle::new(9.5, 400.0)).color(rgba(1.0, 1.0, 1.0, 0.28))),
        )
}

fn main(s: &State) -> El {
    let mut col_main = col().key("main").grow(1.0).min_w(0.0).h_full()
        .child(toolbar(s))
        .child(el().key("toolbar-sep").w_full().h(1.0).fill(hairline()));
    if s.items.is_empty() {
        col_main = col_main.child(boot(s));
    } else {
        col_main = col_main.child(
            el().key("main-scroll").grow(1.0).min_w(0.0).min_h(0.0)
                .scroll(ScrollSpec { stick_bottom: false })
                .child(
                    col().key("main-content")
                        .child(hero(s))
                        .child(grid_header(s))
                        .child(grid(s)),
                ),
        );
    }
    col_main
}

fn toolbar(s: &State) -> El {
    let folder = s.folder.as_ref().map(|f| f.display().to_string()).unwrap_or_else(|| "Folio".into());
    row().key("toolbar").w_full().h(BAR).px(20.0).gap(12.0).center_y()
        .fill(rgba(0.0, 0.0, 0.0, 0.35))
        .backdrop_blur(10.0)
        .window_drag()
        .child(text(folder).font(TextStyle::new(12.5, 500.0)).color(rgba(1.0, 1.0, 1.0, 0.6)).truncate())
        .child(el().grow(1.0))
        .child(
            el().key("open").radius(999.0).h(32.0).pl(14.0).pr(5.0).gap(9.0).center_y()
                .fill(rgba(1.0, 1.0, 1.0, 0.07))
                .border(1.0, hairline())
                .hover(rgba(1.0, 1.0, 1.0, 0.14))
                .press_scale(0.97)
                .on_press_tx(|_s: &mut State, tx: &mut Tx| choose_folder(tx))
                .child(text("Open Folder".to_string()).font(TextStyle::new(12.0, 550.0)).color(rgba(1.0, 1.0, 1.0, 0.9)))
                .child(
                    el().size(22.0, 22.0).radius(11.0).center()
                        .fill(rgba(1.0, 1.0, 1.0, 0.10))
                        .child(text("\u{2197}".to_string()).font(TextStyle::new(11.0, 600.0)).color(rgba(1.0, 1.0, 1.0, 0.85))),
                ),
        )
}

/// The bento hero: the newest photograph, large, beside two stat plates.
fn hero(s: &State) -> El {
    row().key("hero").w_full().px(24.0).pt(26.0).gap(14.0).h(HERO_H)
        .child({
            // Featured: double-bezel shell around the newest photograph.
            let card = el().key("hero-card").grow(1.0).min_w(0.0).h_full()
                .fill(glass())
                .border(1.0, hairline())
                .radius(22.0)
                .padding(7.0)
                .shadow(8.0, 30.0, rgba(0.0, 0.0, 0.0, 0.4))
                .hover(rgba(1.0, 1.0, 1.0, 0.05))
                .press_scale(0.99)
                .on_press_tx(|s: &mut State, tx: &mut Tx| s.show_slide(0, tx))
                .child({
                    // The core: photo fills it; a scrim strip at its foot
                    // carries the caption. All in flow, no absolute math.
                    let mut core = col().key("hero-core").w_full().h_full().min_w(0.0)
                        .radius(15.0)
                        .clip_rounded(15.0)
                        .fill(rgba(0.05, 0.05, 0.055, 1.0));
                    if let Some(item) = s.items.first() {
                        if let Some(pixels) = s.thumbs.get(&item.path) {
                            core = core.child(el().grow(1.0).min_w(0.0).w_full().pixels_fit(pixels, SurfaceFit::Fill));
                        }
                        core = core.child(
                            row().key("hero-scrim").w_full().h(56.0).px(16.0).center_y()
                                .linear_gradient(
                                    0.0,
                                    [(0.0, rgba(0.0, 0.0, 0.0, 0.66)), (1.0, rgba(0.0, 0.0, 0.0, 0.0))],
                                )
                                .child(
                                    col().gap(1.0).grow(1.0)
                                        .child(text(item.name.clone()).font(TextStyle::new(14.0, 600.0)).color(rgba(1.0, 1.0, 1.0, 0.95)).truncate())
                                        .child(text("Latest".to_string()).font(TextStyle::new(10.0, 500.0)).color(rgba(1.0, 1.0, 1.0, 0.62))),
                                )
                                .child(pill("Newest")),
                        );
                    }
                    core
                });
            card
        })
        .child(
            // Stat plates.
            col().key("hero-stats").w(240.0).h_full().gap(14.0)
                .child(
                    col().key("stat-count").grow(1.0).radius(20.0).padding(18.0).gap(6.0)
                        .fill(glass()).border(1.0, hairline())
                        .child(pill("Images"))
                        .child(text(format!("{}", s.items.len())).font(numerals(30.0, 700.0)).color(ink()))
                        .child(text("ready to browse".to_string()).font(TextStyle::new(10.5, 450.0)).color(ink_2())),
                )
                .child(
                    col().key("stat-size").grow(1.0).radius(20.0).padding(18.0).gap(6.0)
                        .fill(glass()).border(1.0, hairline())
                        .child(pill("On disk"))
                        .child(text(bytes_human(s.total_bytes)).font(numerals(30.0, 700.0)).color(ink()))
                        .child(text("read in place".to_string()).font(TextStyle::new(10.5, 450.0)).color(ink_2())),
                ),
        )
}

fn bytes_human(total: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = total as f64;
    if b >= GB {
        format!("{:.2} GB", b / GB)
    } else if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{total} B")
    }
}

fn grid_header(s: &State) -> El {
    let folder = s.folder.as_ref().map(|f| f.display().to_string()).unwrap_or_else(|| "Folio".into());
    row().key("grid-header").w_full().px(24.0).pt(30.0).pb(16.0).gap(14.0)
        .child(
            col().gap(8.0).grow(1.0)
                .child(pill("Library"))
                .child(text(folder).font(TextStyle::new(30.0, 700.0)).color(ink()).truncate()),
        )
        .child(
            el().key("header-hint").center_y()
                .child(text("click a photo to project it \u{00b7} \u{2190} \u{2192} navigate \u{00b7} esc for the grid".to_string())
                    .font(TextStyle::new(10.5, 450.0)).color(rgba(1.0, 1.0, 1.0, 0.4)).truncate()),
        )
}

fn boot(s: &State) -> El {
    let _ = s;
    let hint = if s.folder.is_some() {
        "No supported images found in this folder tree"
    } else {
        "Drop a folder anywhere on this window"
    };
    col().key("boot").grow(1.0).center().gap(16.0)
        .child(pill("Folio"))
        .child(text("Your photos, already here.".to_string()).font(TextStyle::new(30.0, 700.0)).color(ink()))
        .child(text(hint.to_string()).font(TextStyle::new(14.0, 450.0)).color(rgba(1.0, 1.0, 1.0, 0.5)))
        .child(glass_action("Choose Folder").on_press_tx(|_s: &mut State, tx: &mut Tx| choose_folder(tx)))
}

/// Columns follow the laid-out width of the main pane (previous frame), so a
/// resize re-flows instead of overflowing. Min 3, max 9.
fn columns_for(width: f32) -> usize {
    if width <= 1.0 {
        return COLS;
    }
    (((width - 48.0) / (CELL + GAP)).floor() as usize).clamp(3, 9)
}

fn grid(s: &State) -> El {
    let main_w = rune::memo::layout_size("main").map(|[w, _]| w).unwrap_or(1135.0);
    let cols = columns_for(main_w);
    let rows = s.items.len().div_ceil(cols);
    let stack = col().key("rows").w_full().gap(GAP)
        .growth(GrowthSpec::default()).virtualize(CELL + GAP)
        .children((0..rows).map(|r| {
            row().key(format!("row-{r}")).gap(GAP).children(
                (r * cols..((r + 1) * cols).min(s.items.len())).map(|i| cell(s, i)),
            )
        }));
    col().key("scroll").w_full().px(24.0).pb(32.0)
        .scroll(ScrollSpec { stick_bottom: false })
        .child(stack)
}

/// A double-bezel cell: machined glass shell, photo core, caption inside.
fn cell(s: &State, i: usize) -> El {
    let item = &s.items[i];
    let dims = s.dims.get(&item.path).map(|(w, h)| format!("{w} \u{00d7} {h}")).unwrap_or_default();
    let mut shell = col().key(format!("cell-{i}")).w(CELL).padding(7.0).gap(7.0)
        .fill(glass())
        .border(1.0, hairline())
        .radius(18.0)
        .shadow(4.0, 18.0, rgba(0.0, 0.0, 0.0, 0.38))
        .hover(rgba(1.0, 1.0, 1.0, 0.05))
        .press_scale(0.98)
        .help(item.name.clone())
        .on_press_tx(move |s: &mut State, tx: &mut Tx| s.show_slide(i, tx));
    let mut core = el().key(format!("img-{i}")).w_full().h(IMG_H).min_w(0.0).radius(12.0).clip_rounded(12.0)
        .fill(rgba(0.07, 0.07, 0.08, 1.0));
    if let Some(pixels) = s.thumbs.get(&item.path) {
        core = core.child(el().w_full().h_full().pixels_fit(pixels, SurfaceFit::Fill));
    }
    shell = shell.child(core)
        .child(
            text(item.name.clone()).font(TextStyle::new(11.5, 550.0)).color(rgba(1.0, 1.0, 1.0, 0.9)).truncate(),
        )
        .child(
            text(dims).font(numerals(9.5, 450.0)).color(rgba(1.0, 1.0, 1.0, 0.42)).truncate(),
        );
    shell
}

/* ---------------------------------- Slide --------------------------------- */

fn slide(s: &State) -> El {
    let index = s.selected;
    let item = &s.items[index];
    let dims = s.dims.get(&item.path).map(|(w, h)| format!("{w} \u{00d7} {h}")).unwrap_or_default();
    let size = bytes_human(item.size);
    let meta = format!(
        "{} of {}\u{2002}\u{00b7}\u{2002}{}\u{2002}\u{00b7}\u{2002}{}",
        index + 1,
        s.items.len(),
        dims,
        size
    );

    let mut stage = el().key("stage").w_full().grow(1.0).min_h(0.0).fill(Color::BLACK)
        .on_wheel(|s: &mut State, e: rune::WheelEvent, tx| {
            s.set_camera([s.pan[0] + e.dx, s.pan[1] + e.dy], s.zoom);
            tx.live_only();
            true
        })
        .on_magnify(|s: &mut State, e: rune::MagnifyEvent, tx| {
            let zoom = (s.zoom * (1.0 + e.delta)).clamp(1.0, 10.0);
            s.set_camera(s.pan, zoom);
            tx.live_only();
            true
        })
        .on_drag(|s: &mut State, d: &mut rune::Drag, tx: &mut Tx| {
            if d.phase == rune::Phase::Down {
                s.pan_at_press = Some(s.pan);
            }
            let base = s.pan_at_press.unwrap_or([0.0; 2]);
            let pan = if d.cancelled() { base } else { [base[0] + d.dx, base[1] + d.dy] };
            s.set_camera(pan, s.zoom);
            tx.live_only();
        });

    if let Some((_, pixels)) = &s.full {
        stage = stage.child(
            col().key("world").w_full().h_full().center()
                .live_offset(&s.live_pan).live_scale(&s.live_zoom)
                .child(
                    el().key(format!("img-{index}")).w_full().h_full().pixels_fit(pixels, SurfaceFit::Fit)
                        .transition(Transition::scale(0.985)),
                ),
        );
    }

    col().key("slide").w_full().h_full()
        .transition(Transition::scale(0.985))
        .child(el().key("dragstrip").absolute(0.0, 0.0).w_full().h(38.0).window_drag())
        // Top scrim so the controls read over bright photos.
        .child(
            el().key("scrim-top").absolute(0.0, 0.0).w_full().h(110.0)
                .linear_gradient(std::f32::consts::PI, [(0.0, rgba(0.0, 0.0, 0.0, 0.55)), (1.0, rgba(0.0, 0.0, 0.0, 0.0))]),
        )
        .child(stage)
        // Caption + zoom readout, in flow above the tray.
        .child(
            row().key("caption").w_full().px(22.0).pb(10.0).gap(12.0)
                .child(
                    col().gap(2.0).grow(1.0)
                        .child(text(item.name.clone()).font(TextStyle::new(15.0, 600.0)).color(rgba(1.0, 1.0, 1.0, 0.95)).truncate())
                        .child(text(meta).font(numerals(11.0, 500.0)).color(rgba(1.0, 1.0, 1.0, 0.55))),
                )
                .child(
                    el().key("zoom-pill").radius(999.0).h(26.0).px(12.0).center_y()
                        .fill(rgba(1.0, 1.0, 1.0, 0.07))
                        .border(1.0, hairline())
                        .child(
                            text("100%".to_string()).font(numerals(11.0, 550.0))
                                .live_text(&s.zoom_label)
                                .color(rgba(1.0, 1.0, 1.0, 0.8)),
                        ),
                ),
        )
        .child(tray(s))
        // Floating glass controls, top-right inside the scrim.
        .child(
            row().key("slide-controls").pin(None, Some(14.0), Some(18.0), None).gap(8.0)
                .child(glass_action("Index").on_press(|s: &mut State| s.close_slide()))
                .child(glass_action("Open Folder").on_press_tx(|_s: &mut State, tx: &mut Tx| choose_folder(tx))),
        )
        // Folder tag, clear of the traffic lights.
        .child(
            el().key("folder-tag").absolute(84.0, 16.0).h(26.0).px(12.0).center_y().w(320.0)
                .radius(999.0)
                .fill(rgba(0.0, 0.0, 0.0, 0.35))
                .backdrop_blur(8.0)
                .border(1.0, rgba(1.0, 1.0, 1.0, 0.07))
                .window_drag()
                .child(
                    text(s.folder.as_ref().map(|f| f.display().to_string()).unwrap_or_else(|| "Folio".into()))
                        .font(TextStyle::new(11.0, 500.0)).color(rgba(1.0, 1.0, 1.0, 0.55)).truncate(),
                ),
        )
}

fn tray(s: &State) -> El {
    let index = s.selected;
    let count = s.items.len();
    let lower = index.saturating_sub(14);
    let upper = (index + 15).min(count);
    let strip = row().key("tray-strip").gap(9.0).px(20.0).py(11.0)
        .children((lower..upper).map(|i| tray_cell(s, i)));
    col().key("tray-wrap").w_full()
        .child(el().key("tray-sep").w_full().h(1.0).fill(hairline()))
        .child(
            row().key("tray").w_full().h(TRAY).min_h(0.0)
                .fill(rgba(0.02, 0.02, 0.025, 0.72))
                .backdrop_blur(14.0)
                .scroll(ScrollSpec { stick_bottom: false })
                .scroll_x()
                .child(strip),
        )
}

fn tray_cell(s: &State, i: usize) -> El {
    let item = &s.items[i];
    let selected = s.mode == Mode::Slide && s.selected == i;
    let mut cell = el().key(format!("tray-{i}")).size(TRAY_W, TRAY_H).radius(9.0)
        .clip_rounded(9.0).fill(rgba(0.08, 0.08, 0.09, 1.0))
        .border(if selected { 2.0 } else { 1.0 }, if selected { accent() } else { hairline() })
        .shadow(3.0, 10.0, rgba(0.0, 0.0, 0.0, 0.45))
        .press_scale(0.95)
        .help(item.name.clone())
        .on_press_tx(move |s: &mut State, tx: &mut Tx| s.show_slide(i, tx));
    if let Some(pixels) = s.thumbs.get(&item.path) {
        cell = cell.child(el().w_full().h_full().pixels_fit(pixels, SurfaceFit::Fill));
    }
    cell
}
