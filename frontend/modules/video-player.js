/**
 * Binds the active <video> to controls embedded in #viewerToolbar.
 */

function viewerFlags() {
  return globalThis.FolioState ?? { isScrubbingActive: false, isVolumeActive: false };
}

let activeVideo = null;
let activeLayer = null;
let unbind = null;

const VIDEO_ONLY_SELECTOR = '.toolbar-video-only';

function setVideoToolbarVisible(visible) {
  document.querySelectorAll(VIDEO_ONLY_SELECTOR).forEach((el) => {
    el.hidden = !visible;
  });
  document.getElementById('viewer')?.classList.toggle('is-video-mode', visible);
}

function formatTime(seconds) {
  const t = Math.max(0, seconds || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function saveVideoSettings(volume, muted) {
  localStorage.setItem('folio_video_volume', String(volume));
  localStorage.setItem('folio_video_muted', String(muted));
}

export function detachVideoToolbar() {
  if (unbind) {
    unbind();
    unbind = null;
  }
  activeVideo = null;
  activeLayer = null;
  setVideoToolbarVisible(false);
  document.getElementById('viewerToolbar')?.classList.remove('scrubbing-active', 'volume-active');
}

export function bindVideoToolbar(video, layer) {
  detachVideoToolbar();

  const toolbar = document.getElementById('viewerToolbar');
  const scrubWrap = document.getElementById('viewerVideoScrub');
  if (!toolbar || !scrubWrap || !video || !layer) return;

  setVideoToolbarVisible(true);

  const playBtn = document.getElementById('viewerVideoPlayBtn');
  const progress = document.getElementById('viewerVideoProgress');
  const time = document.getElementById('viewerVideoTime');
  const volBtn = document.getElementById('viewerVideoVolBtn');
  const volSlider = document.getElementById('viewerVideoVolSlider');
  if (!playBtn || !progress || !time || !volBtn || !volSlider) return;

  const iconPlay = playBtn.querySelector('.v-icon-play');
  const iconPause = playBtn.querySelector('.v-icon-pause');
  const iconVolHigh = volBtn.querySelector('.v-icon-volume-high');
  const iconVolMuted = volBtn.querySelector('.v-icon-volume-muted');

  activeVideo = video;
  activeLayer = layer;

  let isScrubbing = false;
  let wasPlayingBeforeScrub = false;
  let lastVolume = 0.8;

  const savedVolume = localStorage.getItem('folio_video_volume');
  const savedMuted = localStorage.getItem('folio_video_muted');
  video.volume = savedVolume !== null ? parseFloat(savedVolume) : 0.8;
  video.muted = savedMuted === 'true';
  lastVolume = video.volume > 0 ? video.volume : 0.8;

  const updatePlayButtonUI = () => {
    const paused = video.paused;
    if (iconPlay) iconPlay.style.display = paused ? 'block' : 'none';
    if (iconPause) iconPause.style.display = paused ? 'none' : 'block';
  };

  const updateTimeText = () => {
    const cur = video.currentTime || 0;
    const dur = video.duration || 0;
    time.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
  };

  const updateVolumeUI = () => {
    volSlider.value = video.muted ? 0 : video.volume * 100;
    const muted = video.muted || video.volume === 0;
    if (iconVolHigh) iconVolHigh.style.display = muted ? 'none' : 'block';
    if (iconVolMuted) iconVolMuted.style.display = muted ? 'block' : 'none';
  };

  const onPlayClick = () => {
    if (video.paused) video.play().catch((e) => console.error(e));
    else video.pause();
    updatePlayButtonUI();
  };

  const onVideoPlay = () => updatePlayButtonUI();
  const onVideoPause = () => updatePlayButtonUI();

  const onTimeUpdate = () => {
    if (!isScrubbing && video.duration) {
      progress.value = (video.currentTime / video.duration) * 100;
      updateTimeText();
    }
  };

  const onLoadedMeta = () => updateTimeText();

  const endScrub = () => {
    if (!isScrubbing) return;
    isScrubbing = false;
    toolbar.classList.remove('scrubbing-active');
    viewerFlags().isScrubbingActive = false;
    if (video.duration) {
      video.currentTime = (progress.value / 100) * video.duration;
    }
    if (wasPlayingBeforeScrub) video.play().catch(() => {});
    window.removeEventListener('pointerup', endScrub);
    window.removeEventListener('pointercancel', endScrub);
    window.removeEventListener('mouseup', endScrub);
    window.removeEventListener('blur', endScrub);
  };

  const onProgressDown = () => {
    isScrubbing = true;
    wasPlayingBeforeScrub = !video.paused;
    video.pause();
    toolbar.classList.add('scrubbing-active');
    viewerFlags().isScrubbingActive = true;
    window.addEventListener('pointerup', endScrub);
    window.addEventListener('pointercancel', endScrub);
    window.addEventListener('mouseup', endScrub);
    window.addEventListener('blur', endScrub);
  };

  const onProgressInput = () => {
    if (!video.duration) return;
    const seekTime = (progress.value / 100) * video.duration;
    video.currentTime = seekTime;
    time.textContent = `${formatTime(seekTime)} / ${formatTime(video.duration)}`;
  };

  const endVolDrag = () => {
    toolbar.classList.remove('volume-active');
    viewerFlags().isVolumeActive = false;
    window.removeEventListener('pointerup', endVolDrag);
    window.removeEventListener('pointercancel', endVolDrag);
    window.removeEventListener('mouseup', endVolDrag);
    window.removeEventListener('blur', endVolDrag);
  };

  const onVolDown = () => {
    toolbar.classList.add('volume-active');
    viewerFlags().isVolumeActive = true;
    window.addEventListener('pointerup', endVolDrag);
    window.addEventListener('pointercancel', endVolDrag);
    window.addEventListener('mouseup', endVolDrag);
    window.addEventListener('blur', endVolDrag);
  };

  const onVolInput = () => {
    video.volume = volSlider.value / 100;
    if (video.volume > 0) video.muted = false;
    saveVideoSettings(video.volume, video.muted);
    updateVolumeUI();
  };

  const onVolClick = () => {
    if (video.muted) {
      video.muted = false;
      video.volume = lastVolume > 0 ? lastVolume : 0.8;
    } else {
      lastVolume = video.volume > 0 ? video.volume : lastVolume;
      video.muted = true;
    }
    saveVideoSettings(video.volume, video.muted);
    updateVolumeUI();
  };

  const onVolumeChange = () => {
    if (!video.muted && video.volume > 0) lastVolume = video.volume;
    saveVideoSettings(video.volume, video.muted);
    updateVolumeUI();
  };

  playBtn.addEventListener('click', onPlayClick);
  video.addEventListener('play', onVideoPlay);
  video.addEventListener('pause', onVideoPause);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('loadedmetadata', onLoadedMeta);
  progress.addEventListener('pointerdown', onProgressDown);
  progress.addEventListener('input', onProgressInput);
  volSlider.addEventListener('pointerdown', onVolDown);
  volSlider.addEventListener('input', onVolInput);
  volBtn.addEventListener('click', onVolClick);
  video.addEventListener('volumechange', onVolumeChange);

  updatePlayButtonUI();
  updateVolumeUI();
  updateTimeText();

  unbind = () => {
    playBtn.removeEventListener('click', onPlayClick);
    video.removeEventListener('play', onVideoPlay);
    video.removeEventListener('pause', onVideoPause);
    video.removeEventListener('timeupdate', onTimeUpdate);
    video.removeEventListener('loadedmetadata', onLoadedMeta);
    progress.removeEventListener('pointerdown', onProgressDown);
    progress.removeEventListener('input', onProgressInput);
    volSlider.removeEventListener('pointerdown', onVolDown);
    volSlider.removeEventListener('input', onVolInput);
    volBtn.removeEventListener('click', onVolClick);
    video.removeEventListener('volumechange', onVolumeChange);
    endScrub();
    endVolDrag();
  };
}

/** Toggle play/pause for keyboard shortcut. */
export function toggleVideoPlayback() {
  const v = activeVideo;
  if (!v) return false;
  if (v.paused) v.play().catch(() => {});
  else v.pause();
  return true;
}
