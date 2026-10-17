// Whole-structure drawings: linked lists and trees with pointer labels, and the recursion call tree.
// Pure functions returning HTML/SVG strings.
import { esc, pointerClass, countNodes } from "./render.js";
import { framesAt, callTree, compactText, same } from "./model.js";

// ------------------------------------------------------------------ linked lists
function llNames(model) { // every variable name that is ever a linked list (so a null pointer can still be labelled)
  if (model._llNames) return model._llNames;
  const names = new Set();
  for (const s of model.steps) for (const [n, v] of Object.entries(s.locals)) if (v && v.t === "ll") names.add(n);
  return (model._llNames = names);
}

function chainsOf(model, frames) {
  const chains = [], nones = [], names = llNames(model);
  frames.forEach((f) => {
    for (const [n, s] of Object.entries(f.locals)) {
      if (s.t === "ll") chains.push({ name: n, top: f.isTop, s });
      else if (s.t === "prim" && s.v === null && names.has(n)) nones.push({ name: n, top: f.isTop });
    }
  });
  return { chains, nones };
}
const nodeEdges = (chains) => {
  const m = new Map();
  for (const { s } of chains) s.ids.forEach((id, k) => m.set(id, { val: s.v[k], next: k + 1 < s.ids.length ? s.ids[k + 1] : s.cycle ? s.ids[s.cto] : null }));
  return m;
};

function linkedListHTML(model, i, frames) {
  const { chains, nones } = chainsOf(model, frames);
  if (!chains.length) return "";
  const prevFrames = i > 0 ? framesAt(model, i - 1) : null;
  const prevEdges = prevFrames ? nodeEdges(chainsOf(model, prevFrames).chains) : null;
  const placed = new Map(), rows = [];
  const labelOf = new Map(); // node id -> [{name, top}]
  for (const c of chains) { const id = c.s.ids[0]; if (!labelOf.has(id)) labelOf.set(id, []); labelOf.get(id).push({ name: c.name, top: c.top }); }
  for (const c of [...chains].sort((a, b) => b.s.ids.length - a.s.ids.length)) {
    if (placed.has(c.s.ids[0])) continue;
    const row = { nodes: [], joins: null, cycle: null, cut: c.s.cut };
    for (let k = 0; k < c.s.ids.length; k++) {
      const id = c.s.ids[k];
      if (placed.has(id)) { row.joins = { id, val: c.s.v[k] }; break; }
      placed.set(id, rows.length);
      row.nodes.push({ id, val: c.s.v[k] });
    }
    if (c.s.cycle && !row.joins) row.cycle = { val: c.s.v[c.s.cto], at: c.s.cto };
    rows.push(row);
  }
  const edges = nodeEdges(chains);
  const tagHtml = (id) => (labelOf.get(id) || []).map((l) => `<span class="ptag ${pointerClass(l.name)} ${l.top ? "" : "dimtag"}">${esc(l.name)}</span>`).join("");
  const rowHTML = (row) => {
    const nodes = row.nodes.map((n) => {
      const e = edges.get(n.id), pe = prevEdges && prevEdges.get(n.id);
      const changed = prevEdges && pe && (pe.next !== e.next || !same(pe.val, e.val));
      const isNew = prevEdges && !pe;
      return `<div class="lnode"><div class="llabels">${tagHtml(n.id)}</div><div class="lbox ${changed ? "changed" : ""} ${isNew ? "new" : ""}"><span class="lval">${esc(n.val)}</span><span class="lnext">${e && e.next === null ? "∅" : "•"}</span></div></div>`;
    }).join('<span class="larrow">→</span>');
    const tail = row.joins ? `<span class="larrow">→</span><span class="ljoin" title="joins another chain">↪ ${esc(row.joins.val)}</span>`
      : row.cycle ? `<span class="larrow cyc">↺</span><span class="ljoin cyc">back to ${esc(row.cycle.val)} [${row.cycle.at}]</span>`
      : row.cut ? '<span class="larrow">→ …</span>' : '<span class="larrow">→</span><span class="lnull">None</span>';
    return `<div class="lrow">${nodes}${tail}</div>`;
  };
  const noneHtml = nones.length ? `<div class="lnones">${nones.map((n) => `<span class="ptag ${pointerClass(n.name)} ${n.top ? "" : "dimtag"}">${esc(n.name)}</span>`).join("")}<span class="muted"> → None</span></div>` : "";
  return `<div class="sb-title">Linked list <span class="muted">· pointers shown above nodes</span></div><div class="lscroll">${rows.map(rowHTML).join("")}</div>${noneHtml}`;
}

// ------------------------------------------------------------------ trees
function treeHTML(model, i, frames) {
  let best = null;
  frames.forEach((f, k) => { for (const [, s] of Object.entries(f.locals)) if (s.t === "tree" && s.v) { const n = countNodes(s.v); if (!best || n > best.n) best = { n, s }; } });
  if (!best) for (const s of Object.values(model.input)) if (s.t === "tree" && s.v) { const n = countNodes(s.v); if (!best || n > best.n) best = { n, s }; }
  if (!best) return "";
  const root = structuredClone(best.s.v), pos = []; let order = 0, maxDepth = 0;
  (function place(n, d) { if (!n) return; place(n.l, d + 1); n.x = order++; n.y = d; maxDepth = Math.max(maxDepth, d); pos.push(n); place(n.r, d + 1); })(root, 0);
  const byId = new Map(pos.map((n) => [n.id, n]));

  // pointer labels: tree variables of every live frame; rings: nodes held in collections of the executing frame
  const labels = new Map(), rings = new Map();
  frames.forEach((f) => { for (const [name, s] of Object.entries(f.locals)) if (s.t === "tree" && s.v && byId.has(s.v.id)) { if (!labels.has(s.v.id)) labels.set(s.v.id, []); labels.get(s.v.id).push({ name, top: f.isTop }); } });
  const top = frames[frames.length - 1];
  if (top) for (const [name, s] of Object.entries(top.locals)) if ((s.t === "list" || s.t === "deque" || s.t === "set") && s.v.some((x) => x.t === "node")) for (const x of s.v) if (x.t === "node" && byId.has(x.id)) (rings.get(x.id) || rings.set(x.id, []).get(x.id)).push(name);

  // DFS state from call frames: the node each call is working on
  const state = new Map(); let anyFrame = false;
  for (const f of model.frames.values()) {
    if (f.callStep > i) break;
    if (f.nodeId != null && byId.has(f.nodeId)) { anyFrame = true; state.set(f.nodeId, f.retStep !== null && f.retStep <= i ? "done" : "active"); }
  }
  if (top && top.nodeId != null && byId.has(top.nodeId)) state.set(top.nodeId, "current");

  const W = 32, H = 46, R = 13, maxLabels = Math.max(1, ...[...labels.values()].map((l) => l.length), ...[...rings.values()].map((l) => l.length));
  const x = (n) => n.x * W + R + 4, y = (n) => n.y * H + R + 4;
  const edges = pos.flatMap((n) => [n.l, n.r].filter(Boolean).map((c) => `<line x1="${x(n)}" y1="${y(n)}" x2="${x(c)}" y2="${y(c)}"/>`)).join("");
  const nodes = pos.map((n) => {
    const st = state.get(n.id) || "", lab = labels.get(n.id) || [], ring = rings.get(n.id);
    const labs = lab.map((l, k) => `<text class="tl ${pointerClass(l.name)} ${l.top ? "" : "dimtag"}" x="${x(n)}" y="${y(n) + R + 10 + k * 11}">${esc(l.name)}</text>`).join("");
    return `<g class="tn ${st} ${ring ? "ringed" : ""}"><title>${esc(n.v)}${ring ? " · in " + ring.join(", ") : ""}</title><circle cx="${x(n)}" cy="${y(n)}" r="${R}"/>${ring ? `<circle class="ring" cx="${x(n)}" cy="${y(n)}" r="${R + 4}"/>` : ""}<text x="${x(n)}" y="${y(n)}">${esc(n.v)}</text>${labs}</g>`;
  }).join("");
  const vw = order * W + 8 + R, vh = (maxDepth + 1) * H + maxLabels * 11 + 8;
  const legend = anyFrame ? '<div class="legend"><span><i class="lg current"></i>running now</span><span><i class="lg active"></i>on call stack</span><span><i class="lg done"></i>finished</span></div>' : "";
  return `<div class="sb-title">Binary tree <span class="muted">· labels show which variable points at each node</span></div><div class="lscroll"><svg class="tree-svg big" viewBox="0 0 ${vw} ${vh}" width="${Math.min(vw, 560)}" xmlns="http://www.w3.org/2000/svg">${edges}${nodes}</svg></div>${legend}`;
}

/** Linked lists and trees drawn as whole structures, with variable pointers. Returns "" when the step has none. */
export function renderStructures(model, i) {
  const frames = framesAt(model, i);
  if (!frames.length) return "";
  const parts = [linkedListHTML(model, i, frames), treeHTML(model, i, frames)].filter(Boolean);
  return parts.map((p) => `<div class="struct-block">${p}</div>`).join("");
}

// ------------------------------------------------------------------ recursion call tree
export function renderCallTree(model, i) {
  if (!model.recursive) return "";
  const all = callTree(model, i), nodes = all.slice(0, 160);
  if (nodes.length < 2) return "";
  const kids = new Map(nodes.map((n) => [n.fid, []]));
  const roots = [];
  for (const n of nodes) (n.parent && kids.has(n.parent) ? kids.get(n.parent) : roots).push(n);
  const W = nodes.length > 40 ? 44 : 62, H = 52; let leaf = 0, maxDepth = 0;
  const lay = new Map();
  (function go(n, d) {
    maxDepth = Math.max(maxDepth, d);
    const ks = kids.get(n.fid);
    if (!ks.length) lay.set(n.fid, { x: leaf++ * W + W / 2, y: d * H + 16 });
    else { ks.forEach((k) => go(k, d + 1)); lay.set(n.fid, { x: (lay.get(ks[0].fid).x + lay.get(ks[ks.length - 1].fid).x) / 2, y: d * H + 16 }); }
  })(roots[0], 0);
  const fs = framesAt(model, i), onStack = new Set(fs.map((f) => f.fid)), topFid = fs.length ? fs[fs.length - 1].fid : 0;
  const edges = nodes.filter((n) => n.parent && lay.has(n.parent) && lay.has(n.fid)).map((n) => `<line x1="${lay.get(n.parent).x}" y1="${lay.get(n.parent).y + 11}" x2="${lay.get(n.fid).x}" y2="${lay.get(n.fid).y - 11}"/>`).join("");
  const label = (n) => { const t = Object.values(n.args).map((a) => compactText(a, 2)).join(","); return t.length > 9 ? t.slice(0, 8) + "…" : t; };
  const boxes = nodes.map((n) => {
    const p = lay.get(n.fid); if (!p) return "";
    const cls = n.fid === topFid ? "current" : onStack.has(n.fid) ? "active" : n.done ? "done" : "";
    const t = label(n), w = Math.max(26, t.length * 6.2 + 12);
    const ret = n.done ? `<text class="ct-ret" x="${p.x}" y="${p.y + 24}">${esc(compactText(n.ret, 2).slice(0, 8))}</text>` : "";
    return `<g class="ct ${cls} ${n.repeat ? "repeat" : ""}" data-jump="${n.callStep}"><title>${esc(n.fn)}(${esc(Object.values(n.args).map((a) => compactText(a, 4)).join(", "))})${n.done ? " → " + esc(compactText(n.ret, 4)) : ""}${n.repeat ? " · same arguments as an earlier call" : ""}</title><rect x="${p.x - w / 2}" y="${p.y - 11}" width="${w}" height="22" rx="7"/><text x="${p.x}" y="${p.y}">${esc(t)}</text>${ret}</g>`;
  }).join("");
  const reps = all.filter((n) => n.repeat).length;
  const vw = Math.max(leaf * W + 10, 80), vh = (maxDepth + 1) * H + 14;
  return `<div class="sb-title">Call tree <span class="muted">· ${all.length} call${all.length === 1 ? "" : "s"} so far${all.length > nodes.length ? " (showing first 160)" : ""}</span></div>` +
    `<div class="lscroll"><svg class="calltree-svg" viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}" xmlns="http://www.w3.org/2000/svg">${edges}${boxes}</svg></div>` +
    `<div class="legend"><span><i class="lg current"></i>running</span><span><i class="lg active"></i>waiting</span><span><i class="lg done"></i>returned</span>${reps ? `<span><i class="lg repeat"></i>repeated call · ${reps} (memoization would skip these)</span>` : ""}</div>`;
}
