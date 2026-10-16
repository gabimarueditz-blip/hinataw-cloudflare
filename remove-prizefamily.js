import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const p = join(__dirname, "public", "index.html");
let s = readFileSync(p, "utf8");

// Remove every prizefamily.com network tag at the document level.
// This matches inline <script> blocks that construct their own src from
// prizefamily.com (the kxfdc snippet) as well as any <script src="…prizefamily.com…">.
s = s.replace(/<!-- Prizefamily network tag -->\s*<script>[\s\S]*?prizefamily\.com[\s\S]*?<\/script>\s*/gi, '');
s = s.replace(/<script\b[^>]*\bsrc="https?:\/\/prizefamily\.com[^"]*"[\s\S]*?<\/script>/gi, '');
s = s.replace(/<script\b[^>]*prizefamily\.com[\s\S]*?<\/script>/gi, '');

// Drop the now-empty <script async src="https://pagead2…>
// that only existed to host the Prizefamily network tag sibling.
s = s.replace(
  /<script\s+async\s+src="https:\/\/pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js\?client=ca-pub-7069561404174426"[^>]*>\s*<\/script>\s*/gi,
  ''
);

writeFileSync(p, s, "utf8");
console.log(
  'prizefamily remaining:', (s.match(/prizefamily/gi) || []).length,
  '| bIX.VPs remaining:', (s.match(/bIX\.VPs/gi) || []).length,
  '| adsbygoogle remaining:', (s.match(/googlesyndication\.com\/pagead/gi) || []).length
);
