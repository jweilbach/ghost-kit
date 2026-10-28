import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

// Expand Codex apply_patch into prospective complete files without touching disk.
// Reuse the repository's content validator; do not maintain a second set of rules.
export function patchFiles(patch, root, read = f => readFileSync(f, 'utf8')) {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.shift() !== '*** Begin Patch') throw new Error('Unsupported patch envelope');
  const results = [];
  const path = raw => {
    const p = resolve(root, raw), r = relative(root, p);
    if (r.startsWith('..') || isAbsolute(r)) throw new Error('Patch escapes the repository');
    return p;
  };
  while (lines.length) {
    const header = lines.shift();
    if (header === '*** End Patch') return results;
    let m;
    if ((m = header.match(/^\*\*\* Add File: (.+)$/))) {
      const file = path(m[1]), added = [];
      while (lines.length && !lines[0].startsWith('*** ')) {
        const line = lines.shift(); if (!line.startsWith('+')) throw new Error('Invalid add-file patch');
        added.push(line.slice(1));
      }
      results.push({ file_path: file, content: added.join('\n') + '\n' });
    } else if ((m = header.match(/^\*\*\* Delete File: (.+)$/))) {
      path(m[1]);
    } else if ((m = header.match(/^\*\*\* Update File: (.+)$/))) {
      const original = path(m[1]); let destination = original;
      if (lines[0]?.startsWith('*** Move to: ')) destination = path(lines.shift().slice(13));
      let content = read(original), cursor = 0;
      while (lines.length && !lines[0].startsWith('*** ')) {
        const marker = lines.shift();
        if (!marker.startsWith('@@')) throw new Error('Invalid update hunk');
        const old = [], replacement = [];
        while (lines.length && !lines[0].startsWith('@@') && !lines[0].startsWith('*** ')) {
          const line = lines.shift();
          if (!/^[ +\-]/.test(line)) throw new Error('Unsupported patch line');
          if (line[0] !== '+') old.push(line.slice(1));
          if (line[0] !== '-') replacement.push(line.slice(1));
        }
        const needle = old.join('\n');
        if (!needle) throw new Error('Context-free insertion cannot be safely prevalidated');
        const start = content.indexOf(needle, cursor);
        if (start < 0 || content.indexOf(needle, start + 1) >= 0) throw new Error('Ambiguous patch context; use a larger unique context');
        const value = replacement.join('\n');
        content = content.slice(0, start) + value + content.slice(start + needle.length);
        cursor = start + value.length;
        if (lines[0] === '*** End of File') lines.shift();
      }
      results.push({ file_path: destination, content });
    } else throw new Error('Unknown patch operation');
  }
  throw new Error('Missing patch terminator');
}
