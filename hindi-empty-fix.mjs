import { readFileSync } from 'fs';
const s = readFileSync(process.argv[2] || 'home-payload.log','utf8').split(/\r?\n\r?\n/).slice(1).join(/\r?\n\r?\n/);
const j = JSON.parse(s);
console.log('indiaSeriesAnimes:', j.indiaSeriesAnimes?.length || 0);
console.log('indiaMovieAnimes:', j.indiaMovieAnimes?.length || 0);
console.log('top10Animes keys:', Object.keys(j.top10Animes || {}).join(','));
console.log('trendingAnimes:', (j.trendingAnimes||[]).length);
console.log('latestEpisodeAnimes:', (j.latestEpisodeAnimes||[]).length);
