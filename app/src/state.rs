//! App state and mutations. All UI-thread.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use rune::{Live, LiveText, Pixels, Tx, Waker};

use crate::pipeline::{Job, Msg, Pipeline};

/// How many items get their thumbnails requested right after a scan. The rest
/// fill in as the workers drain the queue (or get promoted by the tray).
const EAGER_THUMBS: usize = 600;

/// Tray neighbours promoted to the front of the decode queue on selection.
const TRAY_RADIUS: usize = 10;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// The full index grid.
    Index,
    /// The projected slide: image fills the screen, tray below.
    Slide,
}

pub struct State {
    pub folder: Option<PathBuf>,
    pub status: String,
    pub items: Vec<folio_scanner::MediaEntry>,
    pub total_bytes: u64,
    pub thumbs: HashMap<PathBuf, Pixels>,
    pub dims: HashMap<PathBuf, (u32, u32)>,
    pub requested: HashSet<PathBuf>,
    pub mode: Mode,
    pub selected: usize,
    pub full: Option<(PathBuf, Pixels)>,
    pub open_slide_on_scan: bool,
    pub pipeline: Pipeline,
    pub wake: Option<Waker>,
    /// Slide camera: drawn = fit * zoom + pan, about the stage centre.
    pub zoom: f32,
    pub pan: [f32; 2],
    pub pan_at_press: Option<[f32; 2]>,
    pub live_zoom: Live<f32>,
    pub live_pan: Live<[f32; 2]>,
    /// The zoom readout updates without commits (LiveText).
    pub zoom_label: LiveText,
}

pub fn state() -> State {
    let folder = rune::extra_args().first().map(PathBuf::from).filter(|p| p.is_dir());
    let open_slide_on_scan = folder.is_some();
    State {
        folder: folder.clone(),
        status: "Ready".into(),
        items: Vec::new(),
        total_bytes: 0,
        thumbs: HashMap::new(),
        dims: HashMap::new(),
        requested: HashSet::new(),
        mode: Mode::Index,
        selected: 0,
        full: None,
        // Image-first: launching with a folder lands on the projected slide.
        open_slide_on_scan,
        pipeline: Pipeline::new(),
        wake: None,
        zoom: 1.0,
        pan: [0.0; 2],
        pan_at_press: None,
        live_zoom: Live::new(1.0),
        live_pan: Live::new([0.0, 0.0]),
        zoom_label: LiveText::new("100%"),
    }
}

impl State {
    pub fn set_camera(&mut self, pan: [f32; 2], zoom: f32) {
        (self.pan, self.zoom) = (pan, zoom.clamp(1.0, 10.0));
        self.live_pan.set(self.pan);
        self.live_zoom.set(self.zoom);
        self.zoom_label
            .set(format!("{}%", (self.zoom * 100.0).round() as i32));
    }

    pub fn reset_camera(&mut self) {
        self.set_camera([0.0, 0.0], 1.0);
    }

    /// The projected slide for `index`; requests the full decode and tray
    /// neighbours.
    pub fn show_slide(&mut self, index: usize, tx: &mut Tx) {
        if index >= self.items.len() {
            return;
        }
        self.mode = Mode::Slide;
        self.selected = index;
        self.full = None;
        self.reset_camera();
        self.promote_tray(index);
        tx.scroll_into_view(format!("tray-{index}"));
        if let Some(path) = self.items.get(index).map(|i| i.path.clone()) {
            self.pipeline.queue.push(Job::Full(path));
        }
    }

    pub fn step_slide(&mut self, offset: isize, tx: &mut Tx) {
        let next = self.selected as isize + offset;
        if next < 0 || next as usize >= self.items.len() {
            return;
        }
        self.show_slide(next as usize, tx);
    }

    pub fn close_slide(&mut self) {
        self.mode = Mode::Index;
        self.full = None;
        self.reset_camera();
    }

    /// Prioritise thumbnails around the projected slide.
    fn promote_tray(&mut self, index: usize) {
        let lower = index.saturating_sub(TRAY_RADIUS);
        let upper = (index + TRAY_RADIUS).min(self.items.len().saturating_sub(1));
        for i in (lower..=upper).rev() {
            let path = self.items[i].path.clone();
            if self.requested.insert(path.clone()) {
                self.pipeline.queue.push_front(Job::Thumb(path));
            }
        }
    }

    pub fn launch_scan(&mut self, folder: PathBuf) {
        self.folder = Some(folder.clone());
        self.status = "Scanning".into();
        self.items = Vec::new();
        self.total_bytes = 0;
        self.thumbs.clear();
        self.dims.clear();
        self.requested.clear();
        self.selected = 0;
        self.full = None;
        self.pipeline.queue.clear();
        self.reset_camera();
        self.open_slide_on_scan = true;
        let tx = self.pipeline.tx.clone();
        let wake = self.wake.clone().expect("setup ran");
        std::thread::spawn(move || {
            let items = folio_scanner::scan(&folder);
            let _ = tx.send(Msg::Scanned { items });
            wake();
        });
    }

    pub fn request_initial_thumbs(&mut self) {
        for entry in self.items.iter().take(EAGER_THUMBS) {
            if self.requested.insert(entry.path.clone()) {
                self.pipeline.queue.push(Job::Thumb(entry.path.clone()));
            }
        }
    }

    /// Drain the mailbox; returns true when anything landed (a frame is due).
    pub fn poll(&mut self, _t: f64, tx: &mut Tx) -> bool {
        let mut changed = false;
        loop {
            let Ok(msg) = self.pipeline.rx.lock().unwrap().try_recv() else { break };
            match msg {
                Msg::Scanned { items } => {
                    self.status = format!("{} images", items.len());
                    self.total_bytes = items.iter().map(|i| i.size).sum();
                    self.items = items;
                    self.request_initial_thumbs();
                    if let Some(folder) = &self.folder {
                        write_last_folder(folder);
                    }
                    if self.open_slide_on_scan && !self.items.is_empty() {
                        self.open_slide_on_scan = false;
                        self.show_slide(0, tx);
                    }
                }
                Msg::Thumb { path, width, height, pixels } => {
                    self.requested.remove(&path);
                    self.dims.insert(path.clone(), (width, height));
                    self.thumbs.insert(path, pixels);
                }
                Msg::Full { path, width, height, pixels } => {
                    self.dims.insert(path.clone(), (width, height));
                    if self.mode == Mode::Slide
                        && self.items.get(self.selected).is_some_and(|it| it.path == path)
                    {
                        self.full = Some((path, pixels));
                    }
                }
            }
            changed = true;
        }
        changed
    }
}

/// AppSpec `poll` field.
pub fn poll(s: &mut State, t: f64, tx: &mut Tx) -> bool {
    s.poll(t, tx)
}

/// The app reopens the last browsed folder, so launch never dead-ends.
fn last_folder_file() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join("Library/Application Support/Folio/last-folder"))
}

pub fn read_last_folder() -> Option<PathBuf> {
    let path = last_folder_file()?;
    let text = std::fs::read_to_string(path).ok()?;
    let folder = PathBuf::from(text.trim());
    folder.is_dir().then_some(folder)
}

fn write_last_folder(folder: &std::path::Path) {
    if let Some(file) = last_folder_file() {
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(file, folder.display().to_string());
    }
}

/// Headless runs (snapshots, trees, scripts) stay deterministic: no threads.
/// The folder scan and a few decodes happen inline so snapshots show real
/// pixels.
pub fn headless() -> bool {
    std::env::args().any(|v| matches!(v.as_str(), "--snap" | "--frames" | "--tree" | "--trace" | "--strip" | "--script"))
}

pub fn setup(s: &mut State, wake: Waker) {
    s.wake = Some(wake.clone());
    if headless() {
        if let Some(folder) = s.folder.clone() {
            s.items = folio_scanner::scan(&folder);
            s.total_bytes = s.items.iter().map(|i| i.size).sum();
            s.status = format!("{} images", s.items.len());
            for entry in s.items.iter().take(30) {
                if let Some(decoded) = crate::decode::decode_scaled(&entry.path, crate::pipeline::THUMB_PX) {
                    let pixels = Pixels::new();
                    pixels.set(decoded.width, decoded.height, decoded.rgba);
                    s.dims.insert(entry.path.clone(), (decoded.width, decoded.height));
                    s.thumbs.insert(entry.path.clone(), pixels);
                }
            }
            s.mode = Mode::Slide;
            s.open_slide_on_scan = false;
            if let Some(entry) = s.items.first() {
                if let Some(decoded) = crate::decode::decode_scaled(&entry.path, crate::pipeline::FULL_PX) {
                    let pixels = Pixels::new();
                    pixels.set(decoded.width, decoded.height, decoded.rgba);
                    s.dims.insert(entry.path.clone(), (decoded.width, decoded.height));
                    s.full = Some((entry.path.clone(), pixels));
                }
            }
        }
        return;
    }
    s.pipeline.spawn_workers(wake.clone());
    if let Some(folder) = s.folder.clone() {
        s.launch_scan(folder);
    } else if let Some(last) = read_last_folder() {
        s.launch_scan(last);
    }
}

pub fn on_key(s: &mut State, e: &rune::KeyEvent, tx: &mut Tx) -> bool {
    match (&e.key, s.mode) {
        (rune::Key::Right, Mode::Slide) => {
            s.step_slide(1, tx);
            true
        }
        (rune::Key::Left, Mode::Slide) => {
            s.step_slide(-1, tx);
            true
        }
        (rune::Key::Escape, Mode::Slide) => {
            s.close_slide();
            true
        }
        (rune::Key::Enter, Mode::Index) => {
            s.show_slide(s.selected, tx);
            true
        }
        _ => false,
    }
}
