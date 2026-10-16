import { readFileSync, writeFileSync } from 'fs';

function patchFile(path, dryRun) {
  const src = readFileSync(path, 'utf8');
  const decl = '      // 4. Hindi Anime (AnimeWorld-India)';
  const idx = src.indexOf(decl);
  if (idx === -1) {
    console.log(`[skip] ${path}: declaration not found`);
    return src;
  }

  const blockStart = idx;
  const blockEnd = src.indexOf('\n    }\n', idx);
  if (blockEnd === -1) {
    console.log(`[skip] ${path}: closing brace not found after declaration`);
    return src;
  }
  const blockEndInclusive = blockEnd + '\n    }\n'.length;

  const before = src.slice(0, blockStart);
  const after = src.slice(blockEndInclusive);

  const newBlock = [
    '      // 4. Hindi Anime (AnimeWorld-India)',
    '      renderHindiSection(data.indiaSeriesAnimes, data.indiaMovieAnimes);',
    '',
    '      // 5. The full Hindi catalogue carousels are not usable right now, so',
    '      //    leave them out of the home page until they are fixed.',
    '      // initHindiAnimeCarousel();',
    '      // initHindiMovieCarousel();',
    '',
  ].join('\n');

  const out = before + newBlock + after;
  if (dryRun) {
    console.log(`[dry-run] ${path}`);
    return src;
  }
  writeFileSync(path, out, 'utf8');
  console.log(`[patched] ${path}`);
  return out;
}

patchFile('public/index.html', false);
patchFile('core/index-html.js', false);
