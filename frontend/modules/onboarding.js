const STORAGE_KEY = 'folio_onboarding_complete';
const STORAGE_VERSION_KEY = 'folio_onboarding_version';
const APP_VERSION = '1.4.0';
let prefControlSequence = 0;

const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to Folio',
    body: 'Fast, private photo and video browsing for macOS. Your library stays on your Mac — no account, no cloud upload.',
  },
  {
    id: 'library',
    title: 'Choose your first library',
    body: 'Open any photo or video folder. Folio reads only locations you choose and keeps thumbnails and metadata in a local cache.',
    primary: 'Open Folder',
  },
  {
    id: 'tour',
    title: 'A focused workspace',
    body: 'Browse in the center, filter from the left sidebar, and inspect metadata or edits on the right. Switch to the catalog whenever you want a broader view.',
    tour: true,
  },
  {
    id: 'prefs',
    title: 'Make it yours',
    body: 'Choose a few useful defaults now. Advanced options, file associations, and cache controls remain available in Settings.',
    prefs: true,
  },
  {
    id: 'done',
    title: 'You\'re ready',
    body: 'Your workspace is ready. Use the home screen to reopen recent libraries, pin favorites, or browse another folder.',
    primary: 'Start browsing',
  },
];

function lsGet(key, fallback = '') {
  const v = localStorage.getItem(key);
  return v === null ? fallback : v;
}

function dispatchPref(key, value) {
  document.dispatchEvent(new CustomEvent('folio-pref-change', { detail: { key, value } }));
}

function addPrefSection(container, title) {
  const h = document.createElement('div');
  h.className = 'onboarding-pref-section';
  h.textContent = title;
  container.appendChild(h);
}

function addPrefRow(container, labelText, control) {
  const row = document.createElement('div');
  row.className = 'onboarding-pref-row';
  const label = document.createElement('label');
  label.textContent = labelText;
  const labeledControl = control.matches?.('input, select, textarea') ? control : control.querySelector?.('input, select, textarea');
  if (labeledControl) {
    labeledControl.id ||= `onboardingPref${++prefControlSequence}`;
    label.htmlFor = labeledControl.id;
  }
  row.append(label, control);
  container.appendChild(row);
}

export function isOnboardingComplete() {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function resetOnboarding() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(STORAGE_VERSION_KEY);
}

export function markOnboardingComplete() {
  localStorage.setItem(STORAGE_KEY, 'true');
  localStorage.setItem(STORAGE_VERSION_KEY, APP_VERSION);
}

/**
 * @param {object} opts
 * @param {(stepId: string) => void} [opts.onOpenFolder]
 * @param {() => void} [opts.onComplete]
 * @param {() => void} [opts.onSkip]
 * @param {(invoke: Function, showToast: Function) => void} [opts.onBindDefaultApp]
 */
export function initOnboarding(opts = {}) {
  if (isOnboardingComplete()) return null;

  const { onOpenFolder, onComplete, onSkip, onBindDefaultApp } = opts;
  let stepIndex = 0;

  const overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';
  overlay.id = 'onboardingOverlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'onboardingTitle');

  const card = document.createElement('div');
  card.className = 'onboarding-card';
  overlay.appendChild(card);

  const progress = document.createElement('div');
  progress.className = 'onboarding-progress';
  card.appendChild(progress);

  const title = document.createElement('h2');
  title.className = 'onboarding-title';
  title.id = 'onboardingTitle';
  card.appendChild(title);

  const body = document.createElement('p');
  body.className = 'onboarding-body';
  card.appendChild(body);

  const extra = document.createElement('div');
  extra.className = 'onboarding-extra';
  card.appendChild(extra);

  const actions = document.createElement('div');
  actions.className = 'onboarding-actions';
  card.appendChild(actions);

  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'onboarding-btn onboarding-btn-ghost';
  skipBtn.textContent = 'Skip';
  actions.appendChild(skipBtn);

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'onboarding-btn onboarding-btn-ghost';
  backBtn.textContent = 'Back';
  actions.appendChild(backBtn);

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'onboarding-btn onboarding-btn-primary';
  nextBtn.textContent = 'Continue';
  actions.appendChild(nextBtn);

  function renderProgress() {
    progress.innerHTML = '';
    STEPS.forEach((step, i) => {
      const dot = document.createElement('span');
      dot.className = 'onboarding-dot' + (i === stepIndex ? ' active' : i < stepIndex ? ' done' : '');
      dot.title = step.title;
      dot.setAttribute('aria-label', `${i + 1}. ${step.title}`);
      progress.appendChild(dot);
    });
    const label = document.createElement('span');
    label.className = 'onboarding-progress-label';
    label.textContent = `${stepIndex + 1} of ${STEPS.length} · ${STEPS[stepIndex].title}`;
    progress.appendChild(label);
  }

  function renderInstallExtra() {
    extra.innerHTML = '';
    const cmd = 'xattr -cr /Applications/Folio.app';
    const label = document.createElement('label');
    label.className = 'onboarding-label';
    label.textContent = 'If macOS says the app is damaged, run once in Terminal:';
    extra.appendChild(label);

    const row = document.createElement('div');
    row.className = 'onboarding-code-row';
    const code = document.createElement('code');
    code.className = 'onboarding-code';
    code.textContent = cmd;
    row.appendChild(code);
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'onboarding-btn onboarding-btn-small';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      } catch {
        copyBtn.textContent = 'Select & copy';
      }
    });
    row.appendChild(copyBtn);
    extra.appendChild(row);

    const hint = document.createElement('p');
    hint.className = 'onboarding-hint';
    hint.textContent = 'Drag Folio into Applications before running this command.';
    extra.appendChild(hint);
  }

  function renderTourExtra() {
    extra.innerHTML = '';
    const list = document.createElement('ul');
    list.className = 'onboarding-tour-list';
    [
      'Left — Library, folders, and smart filters',
      'Center — Viewer, filmstrip, and catalog grid (G)',
      'Right — Inspector: Info, Adjust, Presets, Jobs',
      'I — Metadata · E — Edit · B — Sidebar · G — Catalog',
    ].forEach((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      list.appendChild(li);
    });
    extra.appendChild(list);
  }

  function renderDefaultAppExtra() {
    extra.innerHTML = '';
    const note = document.createElement('p');
    note.className = 'onboarding-hint';
    note.textContent = 'After installing to Applications, rebuild or reinstall once so macOS picks up file associations.';
    extra.appendChild(note);

    const btnRow = document.createElement('div');
    btnRow.className = 'onboarding-action-stack';

    const setDefaultBtn = document.createElement('button');
    setDefaultBtn.type = 'button';
    setDefaultBtn.className = 'onboarding-btn onboarding-btn-primary onboarding-btn-block';
    setDefaultBtn.textContent = 'Set Folio as default for photos & videos';
    setDefaultBtn.addEventListener('click', () => onBindDefaultApp?.('setDefault', setDefaultBtn));
    btnRow.appendChild(setDefaultBtn);

    const manualBtn = document.createElement('button');
    manualBtn.type = 'button';
    manualBtn.className = 'onboarding-btn onboarding-btn-small onboarding-btn-block';
    manualBtn.textContent = 'Show Finder “Open with” steps…';
    manualBtn.addEventListener('click', () => onBindDefaultApp?.('manual', manualBtn));
    btnRow.appendChild(manualBtn);

    extra.appendChild(btnRow);

    const list = document.createElement('ul');
    list.className = 'onboarding-tour-list';
    [
      'Right-click any photo or video → Open With → Folio',
      'To default all files of that type: Finder → Get Info → Open with → Change All…',
      'Or install duti (`brew install duti`) and use the button above',
    ].forEach((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      list.appendChild(li);
    });
    extra.appendChild(list);
  }

  function renderPrefsExtra() {
    extra.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'onboarding-prefs-grid';

    addPrefSection(grid, 'Appearance');
    const themeSelect = document.createElement('select');
    themeSelect.className = 'onboarding-select';
    [['dark', 'Dark'], ['light', 'Light']].forEach(([v, label]) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      if (lsGet('folio_theme', 'dark') === v) opt.selected = true;
      themeSelect.appendChild(opt);
    });
    themeSelect.addEventListener('change', () => {
      localStorage.setItem('folio_theme', themeSelect.value);
      document.dispatchEvent(new CustomEvent('folio-theme-change', { detail: themeSelect.value }));
    });
    addPrefRow(grid, 'Theme', themeSelect);

    const vibCheck = document.createElement('input');
    vibCheck.type = 'checkbox';
    vibCheck.checked = lsGet('folio_vibrancy') === 'true';
    vibCheck.addEventListener('change', () => {
      localStorage.setItem('folio_vibrancy', vibCheck.checked);
      document.dispatchEvent(new CustomEvent('folio-vibrancy-change', { detail: vibCheck.checked }));
    });
    addPrefRow(grid, 'Window vibrancy', vibCheck);

    const hcCheck = document.createElement('input');
    hcCheck.type = 'checkbox';
    hcCheck.checked = lsGet('folio_high_contrast') === 'true';
    hcCheck.addEventListener('change', () => dispatchPref('high_contrast', hcCheck.checked));
    addPrefRow(grid, 'High contrast', hcCheck);

    const motionCheck = document.createElement('input');
    motionCheck.type = 'checkbox';
    motionCheck.checked = lsGet('folio_reduced_motion') === 'true';
    motionCheck.addEventListener('change', () => dispatchPref('reduced_motion', motionCheck.checked));
    addPrefRow(grid, 'Reduce motion', motionCheck);

    const cinematicCheck = document.createElement('input');
    cinematicCheck.type = 'checkbox';
    cinematicCheck.checked = lsGet('folio_cinematic', 'true') !== 'false';
    cinematicCheck.addEventListener('change', () => dispatchPref('cinematic', cinematicCheck.checked));
    addPrefRow(grid, 'Cinematic transitions', cinematicCheck);

    addPrefSection(grid, 'Library');
    const sortSelect = document.createElement('select');
    sortSelect.className = 'onboarding-select';
    [['name', 'Name'], ['date', 'Date'], ['size', 'Size']].forEach(([v, label]) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      if (lsGet('folio_sort', 'name') === v) opt.selected = true;
      sortSelect.appendChild(opt);
    });
    sortSelect.addEventListener('change', () => dispatchPref('sort', sortSelect.value));
    addPrefRow(grid, 'Sort by', sortSelect);

    const recentsCheck = document.createElement('input');
    recentsCheck.type = 'checkbox';
    recentsCheck.checked = lsGet('folio_show_recents', 'true') !== 'false';
    recentsCheck.addEventListener('change', () => dispatchPref('show_recents', recentsCheck.checked));
    addPrefRow(grid, 'Show recent folders', recentsCheck);

    const prefetchCheck = document.createElement('input');
    prefetchCheck.type = 'checkbox';
    prefetchCheck.checked = lsGet('folio_prefetch_enabled', 'true') !== 'false';
    prefetchCheck.addEventListener('change', () => dispatchPref('prefetch', prefetchCheck.checked));
    addPrefRow(grid, 'Navigation prefetch', prefetchCheck);

    addPrefSection(grid, 'Export & sound');
    const stripCheck = document.createElement('input');
    stripCheck.type = 'checkbox';
    stripCheck.checked = lsGet('folio_strip_metadata') === 'true';
    stripCheck.addEventListener('change', () => dispatchPref('strip_metadata', stripCheck.checked));
    addPrefRow(grid, 'Scrub EXIF on export', stripCheck);

    const volRow = document.createElement('div');
    volRow.className = 'onboarding-range-row';
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '100';
    vol.value = lsGet('folio_sound_volume', '40');
    const volVal = document.createElement('span');
    volVal.className = 'onboarding-range-val';
    volVal.textContent = `${vol.value}%`;
    vol.addEventListener('input', () => {
      volVal.textContent = `${vol.value}%`;
      dispatchPref('sound_volume', parseInt(vol.value, 10));
    });
    volRow.append(vol, volVal);
    addPrefRow(grid, 'UI sound volume', volRow);

    const zoomRow = document.createElement('div');
    zoomRow.className = 'onboarding-range-row';
    const zoomSens = document.createElement('input');
    zoomSens.type = 'range';
    zoomSens.min = '1';
    zoomSens.max = '10';
    zoomSens.value = lsGet('folio_zoom_sens', '5');
    const zoomVal = document.createElement('span');
    zoomVal.className = 'onboarding-range-val';
    zoomVal.textContent = zoomSens.value;
    zoomSens.addEventListener('input', () => {
      zoomVal.textContent = zoomSens.value;
      dispatchPref('zoom_sens', parseFloat(zoomSens.value));
    });
    zoomRow.append(zoomSens, zoomVal);
    addPrefRow(grid, 'Zoom sensitivity', zoomRow);

    extra.appendChild(grid);
  }

  function finish(skipped = false) {
    markOnboardingComplete();
    overlay.remove();
    if (skipped) onSkip?.();
    else onComplete?.();
  }

  function render() {
    const step = STEPS[stepIndex];
    title.textContent = step.title;
    body.textContent = step.body;
    extra.innerHTML = '';
    card.classList.toggle('onboarding-card-wide', step.id === 'prefs');
    renderProgress();

    backBtn.style.visibility = stepIndex === 0 ? 'hidden' : 'visible';
    skipBtn.style.display = stepIndex >= STEPS.length - 1 ? 'none' : 'inline-flex';

    if (step.install) renderInstallExtra();
    else if (step.tour) renderTourExtra();
    else if (step.defaultApp) renderDefaultAppExtra();
    else if (step.prefs) renderPrefsExtra();

    if (step.id === 'library') {
      nextBtn.textContent = step.primary || 'Open Folder';
    } else if (step.id === 'done') {
      nextBtn.textContent = step.primary || 'Get started';
    } else {
      nextBtn.textContent = 'Continue';
    }
  }

  skipBtn.addEventListener('click', () => finish(true));
  backBtn.addEventListener('click', () => {
    if (stepIndex > 0) {
      stepIndex -= 1;
      render();
    }
  });
  nextBtn.addEventListener('click', () => {
    const step = STEPS[stepIndex];
    if (step.id === 'library') {
      onOpenFolder?.('library');
      stepIndex += 1;
      render();
      return;
    }
    if (step.id === 'done') {
      finish(false);
      return;
    }
    if (stepIndex < STEPS.length - 1) {
      stepIndex += 1;
      render();
    } else {
      finish(false);
    }
  });

  document.body.appendChild(overlay);
  render();
  requestAnimationFrame(() => overlay.classList.add('visible'));

  return {
    dismiss: () => overlay.remove(),
    finish,
  };
}
