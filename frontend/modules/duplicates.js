/**
 * Duplicate group scoring — pick a recommended "keep" file per UX-6.
 */

function fileName(path) {
  return path.split(/[/\\]/).pop() || path;
}

/** Lower score = more likely a derivative / export copy. */
function copyNamePenalty(name) {
  const n = name.toLowerCase();
  let penalty = 0;
  if (/\bcopy\b|\bcopia\b/.test(n)) penalty += 8000;
  if (/\(\d+\)|-\d+$/.test(n)) penalty += 4000;
  if (/-edit|-export|-converted|_export|_edit/.test(n)) penalty += 3000;
  if (/^screen\s*shot|screenshot|snapchat|whatsapp|img_\d{4}/.test(n)) penalty += 2000;
  return penalty;
}

/**
 * @returns {{ path: string, score: number, item: object|undefined, attr: object|undefined, reasons: string[] }}
 */
export function scoreDuplicateCandidate(path, items, mediaAttributesCache) {
  const item = items.find((it) => it.path === path);
  const attr = mediaAttributesCache?.get?.(path);
  const reasons = [];
  let score = 0;

  const size = item?.size || 0;
  const w = item?.width || 0;
  const h = item?.height || 0;
  const pixels = w * h;

  if (attr?.favorite) {
    score += 120000;
    reasons.push('favorite');
  }
  const rating = attr?.rating || 0;
  if (rating > 0) {
    score += rating * 15000;
    if (rating >= 4) reasons.push('rating');
  }

  score += size;
  if (pixels > 0) {
    score += pixels * 0.05;
    reasons.push('resolution');
  }

  if (item?.focus_score != null && item.focus_score >= 100) {
    score += item.focus_score * 80;
    reasons.push('sharpness');
  }

  score -= copyNamePenalty(fileName(path));

  const ext = fileName(path).split('.').pop()?.toLowerCase() || '';
  if (['cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2'].includes(ext)) {
    score += 500;
    reasons.push('raw');
  }

  return { path, score, item, attr, reasons, size, pixels };
}

export function analyzeDuplicateGroup(groupPaths, items, mediaAttributesCache) {
  const scored = groupPaths
    .map((path) => scoreDuplicateCandidate(path, items, mediaAttributesCache))
    .sort((a, b) => b.score - a.score);

  const keeper = scored[0];
  const keeperReason = keeper ? keeperReasonLabel(keeper, scored) : '';
  return { scored, keeperPath: keeper?.path ?? null, keeperReason };
}

function keeperReasonLabel(keeper, scored) {
  const r = new Set(keeper.reasons);
  if (r.has('favorite')) return 'Marked favorite — best candidate to keep';
  if (r.has('rating')) return `Rated ★${keeper.attr?.rating || 0} — highest rated`;
  if (r.has('sharpness') && keeper.item?.focus_score >= 120) return 'Sharpest focus score in this group';
  if (r.has('raw')) return 'Original RAW — usually the master file';
  if (r.has('resolution')) {
    const w = keeper.item?.width;
    const h = keeper.item?.height;
    if (w && h) return `Highest resolution (${w}×${h})`;
  }
  if (keeper.size > 0) {
    const mb = (keeper.size / 1024 / 1024).toFixed(1);
    return `Largest file (${mb} MB)`;
  }
  if (scored.length > 1) {
    const delta = keeper.score - scored[1].score;
    if (delta < 500) return 'Slight edge — review before deleting others';
  }
  return 'Recommended keep based on size and quality signals';
}

export function hammingSimilarityLabel(diffBits) {
  if (diffBits <= 4) return 'Nearly identical';
  if (diffBits <= 8) return 'Very similar';
  if (diffBits <= 12) return 'Similar';
  return 'Loosely similar';
}
