// The picture-style scene: "Main Block" -> dashed arrows -> function frames with variable tables.
// Also the variable inspector (history + time travel) and the watch list. Pure string builders.
import { esc, renderValue, kindLabel, same } from "./render.js";
import { framesAt, historyOf, lookupVar, numericOf, compactText } from "./model.js";

const argChips = (args) => Object.entries(args).map(([k, v]) => `<span class="achip" title="${esc(k)}">${esc(compactText(v, 3))}</span>`).join("");
const argText = (f) => { const t = Object.values(f.args).map((v) => compactText(v, 2)).join(", "); return t.length > 26 ? t.slice(0, 25) + "…" : t; };

function varRows(f, prevF, ui, model, compactMode) {
  const names = [...Object.keys(f.args).filter((k) => k in f.locals), ...Object.keys(f.locals).filter((k) => !(k in f.args))];
  if (!names.length) return '<tr><td colspan="2" class="muted">no variables yet</td></tr>';
  const ctx = { locals: f.locals, pointers: ui.pointers, roles: model.roles, fid: f.fid, compactMode };
  return names.map((n) => {
    const s = f.locals[n], p = prevF ? prevF.locals[n] : null;
    const changed = prevF && (!p || !same(p, s));
    const kind = compactMode ? "" : kindLabel(s, model.roles[n]);
    return `<tr class="${changed ? "changed" : ""}"><td class="vn" data-var="${esc(n)}" data-fid="${f.fid}" title="Click to inspect history"><span class="vname">${esc(n)}</span>${kind ? `<small>${esc(kind)}</small>` : ""}` +
      `<span class="pin ${ui.pins.has(n) ? "on" : ""}" data-pin="${esc(n)}" title="Watch this variable">★</span></td><td class="vv">${renderValue(n, s, changed || !prevF ? p : p, ctx)}</td></tr>`;
  }).join("");
}

function frameHTML(f, prevF, received, ui, model) {
  const dim = !f.isTop, compactMode = dim && !ui.expanded.has(f.fid);
  const returning = f.isTop && f.ev === "return", entering = f.isTop && f.ev === "call";
  const cls = `blk frame ${dim ? "dim" : "active"} ${returning ? "returning" : ""} ${entering ? "entering" : ""}`;
  const recv = received ? `<div class="recv">↩ received <b>${esc(compactText(received.ret, 4))}</b> from ${esc(received.fn)}()</div>` : "";
  const ret = returning ? `<div class="fret">↩ returns <b>${esc(compactText(f.ret, 6))}</b></div>` : "";
  return `<div class="${cls}" data-fid="${f.fid}"><div class="ftag">function</div>` +
    `<div class="fname"><span data-jump="${f.callStep}" title="Jump to this call">${esc(f.fn)}(${esc(argText(f))})</span>${f.line ? `<span class="lnbadge">L${f.line}</span>` : ""}` +
    `${dim ? `<span class="xp" data-expand="${f.fid}" title="${compactMode ? "Show full values" : "Compact"}">${compactMode ? "▸" : "▾"}</span>` : ""}</div>${recv}` +
    `<div class="tab">Variables</div><table class="vt">${varRows(f, prevF, ui, model, compactMode)}</table>${ret}</div>`;
}

const connHTML = (f) => `<div class="conn" data-jump="${f.callStep}"><span class="cline"></span><span class="clabel">Calls ${f.fn ? `<b>${esc(f.fn)}</b>` : "function"} with ${Object.keys(f.args).length ? "arguments" : "no arguments"} ${argChips(f.args)}</span></div>`;

export function renderScene(model, i, ui) {
  const fs = framesAt(model, i);
  if (!fs.length) return "";
  const prevFs = i > 0 ? framesAt(model, i - 1) : [];
  const prevStep = i > 0 ? model.steps[i - 1] : null;
  const top = fs[fs.length - 1];
  const atEnd = i === model.steps.length - 1;
  // Main Block: the test harness that called the solution, with the inputs as variables.
  const inputs = Object.entries(model.input).map(([n, s]) => `<tr><td class="vn"><span class="vname">${esc(n)}</span></td><td class="vv"><span class="cval editable" data-input="${esc(n)}" title="Click to edit this input and re-run">${esc(compactText(s, 8))}</span></td></tr>`).join("");
  const result = atEnd && !model.error && !model.truncated && model.result ? `<tr class="changed"><td class="vn"><span class="vname">result</span></td><td class="vv"><span class="cval">${esc(compactText(model.result, 10))}</span></td></tr>` : "";
  const main = `<div class="blk main"><div class="mtitle">Main Block</div><div class="tab">Variables</div><table class="vt">${inputs}${result}</table></div>`;

  let shown = fs, hidden = 0;
  if (!ui.showAll && fs.length > 6) { shown = [fs[0], ...fs.slice(-4)]; hidden = fs.length - 5; }
  const received = prevStep && prevStep.ev === "return" && prevStep.depth === top.depth + 1 ? { ret: prevStep.ret, fn: prevStep.fn } : null;
  const parts = [main];
  shown.forEach((f, k) => {
    if (k === 1 && hidden) parts.push(`<button class="more-frames" data-showall="1">⋯ ${hidden} earlier call${hidden === 1 ? "" : "s"} hidden · show all</button>`);
    parts.push(connHTML(f));
    parts.push(frameHTML(f, prevFs.find((p) => p.fid === f.fid) || null, f.isTop ? received : null, ui, model));
  });
  if (ui.showAll && fs.length > 6) parts.push(`<button class="more-frames" data-showall="0">collapse older calls</button>`);
  return parts.join("");
}

// ------------------------------------------------------------------ sparkline, inspector, watch
export function sparkline(points, curIdx, w = 150, h = 34) {
  if (points.length < 2) return "";
  const lo = Math.min(...points), hi = Math.max(...points), span = hi - lo || 1;
  const px = (k) => 3 + (k / (points.length - 1)) * (w - 6), py = (v) => h - 4 - ((v - lo) / span) * (h - 8);
  const line = points.map((v, k) => `${px(k).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const c = Math.max(0, Math.min(points.length - 1, curIdx));
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${line}"/><circle cx="${px(c).toFixed(1)}" cy="${py(points[c]).toFixed(1)}" r="3"/></svg>`;
}

export function renderInspector(model, i, insp, ui) {
  if (!insp) return "";
  const meta = model.frames.get(Number(insp.fid));
  if (!meta) return "";
  const idx = insp.idx === undefined || insp.idx === "" ? undefined : /^\d+$/.test(insp.idx) ? Number(insp.idx) : /^\d+,\d+$/.test(insp.idx) ? undefined : undefined;
  const hist = historyOf(model, meta.fid, insp.name, idx);
  const upto = hist.filter((h) => h.step <= i), cur = upto[upto.length - 1];
  const nums = hist.map((h) => numericOf(h.snap)), numeric = nums.length > 1 && nums.every((v) => v !== null && Number.isFinite(Number(v))) ? nums.map(Number) : null;
  const label = `${insp.name}${idx !== undefined ? `[${idx}]` : ""}`;
  const rows = hist.slice(-40).map((h) => `<div class="hrow ${cur && h.step === cur.step ? "now" : ""} ${h.step > i ? "future" : ""}" data-jump="${h.step}"><span class="hs">step ${h.step + 1}</span><span class="hl">L${h.line}</span><span class="hv">${esc(compactText(h.snap, 8))}</span></div>`).join("");
  return `<div class="inspector"><div class="ins-head"><b>${esc(label)}</b> <span class="muted">in ${esc(meta.fn)}() · ${hist.length} change${hist.length === 1 ? "" : "s"}</span>` +
    `<span class="ins-btns"><button class="ghost" data-pin="${esc(insp.name)}">${ui.pins.has(insp.name) ? "★ Unwatch" : "☆ Watch"}</button><button class="ghost" data-close="1">✕</button></span></div>` +
    `<div class="ins-cur">${cur ? esc(compactText(cur.snap, 30)) : '<span class="muted">not assigned yet at this step</span>'}</div>` +
    `${numeric ? `<div class="ins-spark">${sparkline(numeric, upto.length ? upto.length - 1 : 0, 220, 40)}<span class="muted">${nums.some((_, k) => hist[k].snap.t !== "prim") ? "length" : "value"} over time</span></div>` : ""}` +
    `<div class="hist">${rows || '<span class="muted">No recorded values.</span>'}</div><div class="muted ins-tip">Click a row to jump to that moment.</div></div>`;
}

export function renderWatch(model, i, ui) {
  if (!ui.pins.size) return "";
  const items = [...ui.pins].map((name) => {
    const hit = lookupVar(model, i, name);
    if (!hit) return `<div class="witem"><span class="wn">${esc(name)}</span><span class="muted">not in scope</span><span class="unpin" data-pin="${esc(name)}" title="Remove">×</span></div>`;
    const hist = historyOf(model, hit.fid, name), nums = hist.map((h) => numericOf(h.snap));
    const ok = nums.length > 1 && nums.every((v) => v !== null && Number.isFinite(Number(v)));
    const cur = hist.filter((h) => h.step <= i).length - 1;
    return `<div class="witem" data-var="${esc(name)}" data-fid="${hit.fid}"><span class="wn">${esc(name)}</span><span class="wv">${esc(compactText(hit.snap, 4))}</span>${ok ? sparkline(nums.map(Number), cur, 80, 22) : ""}<span class="unpin" data-pin="${esc(name)}" title="Remove">×</span></div>`;
  }).join("");
  return `<div class="watch"><div class="sb-title">Watch</div>${items}</div>`;
}
