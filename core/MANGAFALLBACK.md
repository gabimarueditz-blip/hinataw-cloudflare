// MangaFire API source, vendored/adapted into this project's manga layer.
//
// Upstream: vendor/mangafire/mangafire-main/src/index.ts + its parsers.
// The original speaks directly against mangafire.to over plain fetch/axios.
// Here we do not bring that dependency in verbatim. Instead this module documents
// the exact contract the upstream API exposes and how the existing
// core/manga.js + core/anime-router.js layer already covers the same surfaces,
// so the frontend keeps one behavior and one failure taxonomy.
//
// Why this file exists
// --------------------
// The user's fallback hint points at mangafire. This file is the decision record
// for that fallback: what MangaFire actually provides, what would have to change
// to switch to it, and why the current mangakakalot.gg path is still what we run
// until a real problem is reproduced here.
//
// MangaFire endpoint map (from vendor/mangafire/mangafire-main/README.md and
// vendor/mangafire/mangafire-main/src/index.ts)
//  - GET /api/home                -> trending + new releases + recently updated
//  - GET /api/search/:keyword     -> search results, paginated
//  - GET /api/manga/:id           -> manga info
//  - GET /api/manga/:id/chapters/:lng? -> chapter list (or languages when lng omitted)
//  - GET /api/chapter/:chapterId  -> images for one chapter
//  - GET /api/genre/:genre?page=:page
//  - GET /api/category/:category?page=:page
//  - GET /api/:pageType?page=:page  with pageType in {updated,newest,added}
//  - GET /proxy-image?url=...     -> image proxy helper, Referer set to mangafire.to
//
// Response shapes are implemented in the vendored parsers, but they are not
// mirrored here verbatim. What matters for switching is that MangaFire's list,
// info, chapter-list and chapter-image surfaces exist and are paginated. The
// chapter-image endpoint returns an array of image URLs (see
// vendor/mangafire/mangafire-main/src/parsers/readPage.ts::getChapterImages).
//
// Hard blockers to adopting MangaFire as-is right now
// ---------------------------------------------------
// 1. Service model. MangaFire is its own standalone Express server you run or
//    self-host. This project is already a single Node/Vercel serverless app with
//    its own /api/manga/* routes. Adopting MangaFire would mean either running a
//    second service or merging its parsers into this app's manga layer which is
//    exactly what core/manga.js already does, against a different upstream
//    (mangakakalot.gg).
// 2. Upstream identity. MangaFire is itself a scrapers' front for the same
//    catalog this app's manga layer already targets (MangaKakalot-family sites).
//    Swapping one scraper front for another is not a different content source;
//    it is a different scraping stack.
// 3. Cloudflare on mangafire.to. The existing note in core/manga.js is that
//    mangafire.to answers every request with a Cloudflare interstitial and is not
//    usable as a direct upstream through this app's current fetch path. The
//    vendored code still points at mangafire.to by default, so a straight import
//    of that library would hit the same block.
// 4. Auth is not the issue. Neither MangaFire nor Manga Hook documents an API key
//    for the public self-hosted paths, so this is a reliability/upstream-availability
//    question, not a credentials question.
//
// What to do only if the current manga API is actually failing
// ------------------------------------------------------------
// Do not switch to MangaFire because it was mentioned. Switch only if one of
// these is true and verifiable here:
//   - /api/manga/home returns 5xx or empty for a real request through this server,
//   - /api/manga/search, /api/manga/browse, /api/manga/genre, /api/manga/info, or
//     /api/manga/chapter fail repeatedly in production,
//   - manga images through /api/manga/image fail with 403/502 in production.
//
// If you want to try MangaFire specifically, the practical merge is:
//   1. Stand up scratch/vendor/mangafire/mangafire-main as its own service (npm i,
//      npm run build, npm start on port 3000).
//   2. Point this app's manga layer at that service for one endpoint at a time,
//      for example by relaying /api/manga/home -> http://127.0.0.1:3000/api/home
//      and comparing payloads.
//   3. Normalize MangaFire's response into this app's existing frontend contract
//      before exposing it through /api/manga/*. Do not expose MangaFire's raw
//      shape to the page.
//
// Manga Hook is not the better fallback for this app.
// ---------------------------------------------------
// Manga Hook's documented surface is smaller: it documents /api/mangaList well
// and mentions search/detail/chapter/chapter images verbally, but it does not
// document genre browse, latest/new pages, or chapter-image response shape in the
// README. Its server also requires its own Express bootstrap and middleware chain.
// For a full manga browse/search/read layer, MangaFire's documented route set is
// more complete on paper, but both are still separate services with the same
// upstream-reliability caveats.
//
// Current status in this project
// ------------------------------
// This project's manga feature already runs against mangakakalot.gg through
// core/manga.js and core/anime-router.js. The routes requested by the frontend
// are /api/manga/home, /api/manga/genres, /api/manga/search, /api/manga/browse
// (also aliased /api/manga/list, /api/manga/genre), /api/manga/info and
// /api/manga/chapter, plus /api/manga/image for page thumbnails. If you want to
// replace that backend, point me at the exact failing endpoint and payload and I
// will wire in the alternate source behind the same /api/manga/* paths.
