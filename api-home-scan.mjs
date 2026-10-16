import { readFileSync } from 'fs';
function scan(name, file){
  const body = readFileSync(file, 'utf8').split(/\r?\n\r?\n/).slice(1).join(/\r?\n\r?\n/);
  const bad = /hindi|dubbed|India|Hindi/gi;
  const hits = [...body.matchAll(bad)].map(x => x[0]);
  console.log(name);
  console.log('  size:', body.length, 'hindi/dubbed hits:', hits.length, hits.slice(0,10).join(', '));
}
scan('/api/home', 'hindi-home-default.log');
scan('/api/anime/home?lang=hindi', 'hindi-home-param.log');
