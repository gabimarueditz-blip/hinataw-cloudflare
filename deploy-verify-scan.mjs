import { readFileSync } from 'fs';
const s = readFileSync('deploy-verify-final.log', 'utf8');
const body = s.split(/\r?\n\r?\n/).slice(1).join(/\r?\n\r?\n/);
const bad = /n6wxm\.com|nap5k\.com|5gvci\.com|MovieBox|ToonStream|ToonWorld|AnimeWorld|AnimeDekho|hianime-global|animeworld-india|anime-world-india/gi;
const hits = [...body.matchAll(bad)].map(x => x[0]);
console.log('bad-string hits in live response:', hits.length, hits.slice(0, 20).join(', '));
console.log('html present:', /<!DOCTYPE html>|<html/i.test(body));
