import { setTimeout } from "node:timers/promises";

const candidates = [
  { subjectId: "2967249287006023912", path: "doraemon-nobita-and-the-new-castle-of-the-undersea-devil-hindi-m97ZZF32cx3" },
  { subjectId: "2225435141369905464", path: "blue-box-hindi-0enb9E1woE2" },
  { subjectId: "3997659161797476824", path: "ranma-1-2-hindi-s8JndmVjjL4" },
  { subjectId: "6327838343157930872", path: "jaadugar-a-witch-in-mongolia-hindi-gYabfz8zrx7" },
  { subjectId: "6446851041895370536", path: "the-ramparts-of-ice-hindi-I2AUVR3EeG7" },
  { subjectId: "7967254200902451552", path: "welcome-to-demon-school-iruma-kun-hindi-cgHJ76K6yu9" },
];

for (const c of candidates) {
  const url =
    `http://localhost:3000/api/moviebox/stream?subjectId=${c.subjectId}&path=${c.path}&se=1&ep=1`;

  let body = "";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    body = await res.text();
  } catch (e) {
    console.log(`[${c.subjectId}] fetch failed: ${e.message}`);
    continue;
  }

  let d;
  try { d = JSON.parse(body); } catch (e) {
    console.log(`[${c.subjectId}] not json: ${body.slice(0, 200)}`);
    continue;
  }

  console.log(`[${c.subjectId}] success=${d.success} hasResource=${d.hasResource} ${d.error ? "err="+d.error : ""}`);
  if (d.sources && d.sources.length) {
    console.log(`  sources(${d.sources.length}):`);
    for (const s of d.sources.slice(0, 3)) {
      console.log(`    - ${s.server || s.name || s.provider} | type=${s.type} | quality=${s.quality || ""} | ${s.url || s.link || "" ? "URL="+ String(s.url || s.link).slice(0,120) : ""}`);
    }
    break;
  }
  if (d.data && d.data.sources && d.data.sources.length) {
    console.log(`  data.sources(${d.data.sources.length}):`);
    for (const s of d.data.sources.slice(0, 3)) {
      console.log(`    - ${s.server || s.name} | type=${s.type} | ${s.url || s.link || "" ? "URL="+ String(s.url || s.link).slice(0,120) : ""}`);
    }
    break;
  }
}
console.log("done");
