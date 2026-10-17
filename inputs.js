// Language-neutral helpers: pull "Input: ... Output: ..." examples out of a LeetCode statement,
// and split "nums = [1,2], target = 3" into ordered [name, jsonText] pairs.
export function parseExamples(problemText) {
  const examples = [];
  const re = /Input:\s*([\s\S]+?)\s*Output:\s*([\s\S]+?)(?=\n\s*(?:Explanation:|Example\s*\d|Constraints:|Input:)|$)/gi;
  let m;
  while ((m = re.exec(problemText || "")) !== null) {
    examples.push({ label: `Example ${examples.length + 1}`, input: m[1].replace(/\s+/g, " ").trim(), output: m[2].replace(/\s+/g, " ").trim() });
  }
  return examples;
}

/** Returns [[name, jsonText], ...]; throws Error with a user-friendly message. */
export function splitInput(text) {
  const src = text.trim();
  const depth = new Array(src.length + 1).fill(0), inStr = new Array(src.length + 1).fill(false);
  let d = 0, q = null;
  for (let i = 0; i < src.length; i++) {
    depth[i] = d; inStr[i] = q !== null;
    const c = src[i];
    if (q) { if (c === q && src[i - 1] !== "\\") q = null; }
    else if (c === '"' || c === "'") q = c;
    else if ("[({".includes(c)) d++;
    else if ("])}".includes(c)) d--;
  }
  const starts = [], re = /(^|,)\s*([A-Za-z_]\w*)\s*=(?!=)\s*/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const nameStart = m.index + m[0].indexOf(m[2], m[1].length);
    if (depth[nameStart] === 0 && !inStr[nameStart]) starts.push({ name: m[2], valueStart: m.index + m[0].length, matchStart: m.index });
    else re.lastIndex = m.index + 1;
  }
  if (!starts.length) throw new Error("Input must look like:  nums = [1,2,3], target = 6");
  return starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].matchStart : src.length;
    return [s.name, src.slice(s.valueStart, end).trim().replace(/,$/, "").trim()];
  });
}

/** Parse one value as JSON, tolerating single-quoted chars and Python-style True/False/None. */
export function parseValue(name, raw) {
  let out = "", q = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q === '"') { out += c; if (c === '"' && raw[i - 1] !== "\\") q = null; }
    else if (q === "'") { if (c === "'") { q = null; out += '"'; } else out += c === '"' ? '\\"' : c; }
    else if (c === '"') { q = '"'; out += c; }
    else if (c === "'") { q = "'"; out += '"'; }
    else out += c;
  }
  out = out.replace(/\bNone\b/g, "null").replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false");
  try { return JSON.parse(out); } catch { throw new Error(`Could not read the value of '${name}': ${raw.slice(0, 40)}`); }
}
