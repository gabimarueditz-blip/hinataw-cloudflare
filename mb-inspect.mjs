import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync("mb_home.json", "utf8"));
const secs = d.sections || [];
console.log("sections:", secs.map(s => s.title));
const ani = secs.filter(s => s.items && s.items.some(i => (i.genre || "").toLowerCase().includes("anime")));
console.log("anime sections:", ani.length);
ani.slice(0, 40).forEach(s => {
  console.log(" -", s.title, "items:", s.items.length);
  s.items.slice(0, 12).forEach(i => console.log("    ", i.title, "|", i.genre, "|", i.badge, "|", i.type, "|", i.id, "|", i.slug));
});
