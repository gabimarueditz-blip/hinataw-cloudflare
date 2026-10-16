import { FEATURED_ANIME } from "./anime-service.js";
import "./hianime-service.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

//#region core/hianime-sync.js
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const CACHE_FILE = join(DATA_DIR, "hianime-cache.json");
const BASE_URL = "https://hianime.at";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SYNC_INTERVAL_MS = 360 * 60 * 1e3;
let syncState = {
	isSyncing: false,
	lastSyncTime: 0,
	nextSyncTime: 0,
	totalAnimeCount: 0,
	lastError: null,
	syncLogs: [],
	data: {
		spotlight: [],
		trending: [],
		latestEpisodes: [],
		topAiring: [],
		mostPopular: [],
		mostFavorite: [],
		latestCompleted: [],
		topUpcoming: [],
		allAnime: [],
		categories: {}
	}
};
function logSync(msg) {
	const entry = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}`;
	console.log(`[HiAnime Sync] ${entry}`);
	syncState.syncLogs.unshift(entry);
	if (syncState.syncLogs.length > 50) syncState.syncLogs.pop();
}
function decodeEntities(str) {
	return (str || "").replace(/&#039;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}
function parseHiAnimeCards(html, categoryName = "general") {
	const items = [];
	if (!html) return items;
	const chunks = html.split(/<div class="flw-item/);
	for (let i = 1; i < chunks.length; i++) try {
		const chunk = chunks[i];
		const imgMatch = chunk.match(/src="([^"]+)"/);
		const posterUrl = imgMatch ? imgMatch[1] : "";
		const idMatch = chunk.match(/data-id="(\d+)"/);
		const linkMatch = chunk.match(/href="([^"]+)"/);
		const id = idMatch ? idMatch[1] : "";
		const watchUrl = linkMatch ? linkMatch[1] : "";
		const titleMatch = chunk.match(/class="dynamic-name"[^>]*data-jname="([^"]*)"[^>]*>([^<]+)<\/a>/) || chunk.match(/class="dynamic-name"[^>]*>([^<]+)<\/a>/);
		let titleEnglish = "";
		let titleJname = "";
		if (titleMatch) if (titleMatch.length >= 3) {
			titleJname = decodeEntities(titleMatch[1]);
			titleEnglish = decodeEntities(titleMatch[2]);
		} else titleEnglish = decodeEntities(titleMatch[1]);
		const subMatch = chunk.match(/tick-sub[^>]*>[\s\S]*?(\d+)\s*<\/div>/);
		const dubMatch = chunk.match(/tick-dub[^>]*>[\s\S]*?(\d+)\s*<\/div>/);
		const epsMatch = chunk.match(/tick-eps[^>]*>[\s\S]*?(\d+)\s*<\/div>/);
		const subCount = subMatch ? parseInt(subMatch[1], 10) : 0;
		const dubCount = dubMatch ? parseInt(dubMatch[1], 10) : 0;
		const totalEps = epsMatch ? parseInt(epsMatch[1], 10) : subCount || dubCount || 12;
		const formatMatch = chunk.match(/<span class="fdi-item">([^<]+)<\/span>/);
		const durationMatch = chunk.match(/<span class="fdi-item fdi-duration">([^<]+)<\/span>/);
		const format = formatMatch ? decodeEntities(formatMatch[1]).toUpperCase() : "TV";
		const duration = durationMatch ? decodeEntities(durationMatch[1]) : "24m";
		if (id && (titleEnglish || titleJname)) {
			const displayTitle = titleEnglish || titleJname;
			const cleanDisplay = displayTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
			const matchedFeatured = FEATURED_ANIME.find((f) => {
				const fEnglish = (f.title?.english || "").toLowerCase().replace(/[^a-z0-9]/g, "");
				const fRomaji = (f.title?.romaji || "").toLowerCase().replace(/[^a-z0-9]/g, "");
				return cleanDisplay && (cleanDisplay === fEnglish || cleanDisplay === fRomaji);
			});
			const finalPoster = posterUrl || matchedFeatured?.coverImage?.extraLarge || matchedFeatured?.coverImage?.large || "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg";
			const resolvedId = id || matchedFeatured?.hianimeId;
			items.push({
				id: Number(resolvedId) || resolvedId,
				hianimeId: String(resolvedId),
				title: {
					english: displayTitle,
					romaji: titleJname || displayTitle,
					userPreferred: displayTitle
				},
				titleStr: displayTitle,
				coverImage: {
					extraLarge: finalPoster,
					large: finalPoster,
					medium: finalPoster
				},
				poster: finalPoster,
				bannerImage: matchedFeatured?.bannerImage || finalPoster,
				episodes: totalEps,
				subCount: subCount || totalEps,
				dubCount,
				totalEpisodes: totalEps,
				latestEpisode: subCount || totalEps,
				format,
				duration,
				category: categoryName,
				url: watchUrl.startsWith("http") ? watchUrl : `${BASE_URL}${watchUrl}`,
				syncedAt: Date.now()
			});
		}
	} catch (e) {}
	return items;
}
function parseHiAnimeSpotlights(html) {
	const spotlights = [];
	if (!html) return spotlights;
	const sliderStart = html.indexOf("id=\"slider\"");
	if (sliderStart === -1) return spotlights;
	const slides = html.substring(sliderStart, sliderStart + 35e3).split("<div class=\"deslide-item\">");
	for (let i = 1; i < slides.length; i++) try {
		const slide = slides[i];
		const imgMatch = slide.match(/<img [^>]*class="film-poster-img"[^>]*src="([^"]+)"/) || slide.match(/src="([^"]+)"/);
		const rankMatch = slide.match(/class="desi-sub-text">#?(\d+)?\s*Spotlight<\/div>/);
		const titleMatch = slide.match(/class="desi-head-title dynamic-name"[^>]*data-jname="([^"]*)"[^>]*>([\s\S]*?)<\/div>/);
		const descMatch = slide.match(/class="desi-description">([\s\S]*?)<\/div>/);
		const watchMatch = slide.match(/href="([^"]+)"[^>]*class="[^"]*btn-slide-watch[^"]*"/) || slide.match(/href="([^"]+)"/);
		const formatMatch = slide.match(/<i class="fas fa-play-circle mr-1"><\/i>([^<]+)/);
		const durationMatch = slide.match(/<i class="fas fa-clock mr-1"><\/i>([^<]+)/);
		const subMatch = slide.match(/tick-sub[^>]*>[\s\S]*?(\d+)\s*<\/div>/);
		const dubMatch = slide.match(/tick-dub[^>]*>[\s\S]*?(\d+)\s*<\/div>/);
		const banner = imgMatch ? imgMatch[1] : "";
		const rank = rankMatch && rankMatch[1] ? parseInt(rankMatch[1], 10) : i;
		const jname = titleMatch ? decodeEntities(titleMatch[1].trim()) : "";
		const displayTitle = (titleMatch ? decodeEntities(titleMatch[2].replace(/<[^>]*>/g, "").trim()) : "") || jname;
		const desc = descMatch ? decodeEntities(descMatch[1].replace(/<[^>]*>/g, "").trim()) : "";
		const watchUrl = watchMatch ? watchMatch[1].trim() : "";
		const cleanUrl = (watchUrl || "").split("?")[0].replace(/\/$/, "");
		const idMatch = cleanUrl.match(/-(\d+)$/) || cleanUrl.match(/\/(\d+)$/) || slide.match(/data-id="(\d+)"/);
		const cleanDisplay = displayTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
		const matchedFeatured = FEATURED_ANIME.find((f) => {
			const fEnglish = (f.title?.english || "").toLowerCase().replace(/[^a-z0-9]/g, "");
			const fRomaji = (f.title?.romaji || "").toLowerCase().replace(/[^a-z0-9]/g, "");
			return cleanDisplay && (cleanDisplay === fEnglish || cleanDisplay === fRomaji);
		});
		const id = idMatch ? idMatch[1] : matchedFeatured?.hianimeId || matchedFeatured?.id;
		if (!id) continue;
		const finalPoster = banner || matchedFeatured?.coverImage?.extraLarge || matchedFeatured?.bannerImage || "";
		const subCount = subMatch ? parseInt(subMatch[1], 10) : 24;
		const dubCount = dubMatch ? parseInt(dubMatch[1], 10) : 0;
		const format = formatMatch ? decodeEntities(formatMatch[1]).trim() : "TV";
		const duration = durationMatch ? decodeEntities(durationMatch[1]).trim() : "24m";
		if (displayTitle && (finalPoster || banner)) spotlights.push({
			id: Number(id) || id,
			hianimeId: String(id),
			rank,
			title: {
				english: displayTitle,
				romaji: jname || displayTitle,
				userPreferred: displayTitle
			},
			titleStr: displayTitle,
			bannerImage: finalPoster || banner,
			coverImage: {
				extraLarge: finalPoster,
				large: finalPoster,
				medium: finalPoster
			},
			poster: finalPoster,
			description: desc,
			format,
			duration,
			episodes: subCount || 24,
			subCount,
			dubCount,
			totalEpisodes: subCount || 24,
			latestEpisode: subCount || 24,
			url: watchUrl.startsWith("http") ? watchUrl : `${BASE_URL}${watchUrl}`,
			syncedAt: Date.now()
		});
	} catch (e) {}
	return spotlights;
}
function parseHiAnimeTrending(html) {
	const trending = [];
	if (!html) return trending;
	const trendMatch = html.match(/<div id="anime-trending">([\s\S]*?)<\/section>/);
	if (!trendMatch) return trending;
	const slides = trendMatch[1].split("<div class=\"swiper-slide\">");
	for (let i = 1; i < slides.length; i++) try {
		const slide = slides[i];
		const numMatch = slide.match(/class="number"[\s\S]*?<span>(\d+)<\/span>/);
		const titleMatch = slide.match(/class="film-title dynamic-name"[^>]*data-jname="([^"]*)"[^>]*>([\s\S]*?)<\/div>/) || slide.match(/class="film-title dynamic-name"[^>]*>([\s\S]*?)<\/div>/);
		const hrefMatch = slide.match(/href="([^"]+)"/);
		const imgMatch = slide.match(/<img [^>]*src="([^"]+)"/);
		if (numMatch && (titleMatch || hrefMatch)) {
			const rank = parseInt(numMatch[1], 10);
			let jname = "";
			let english = "";
			if (titleMatch) if (titleMatch.length >= 3) {
				jname = decodeEntities(titleMatch[1].trim());
				english = decodeEntities(titleMatch[2].replace(/<[^>]*>/g, "").trim());
			} else english = decodeEntities(titleMatch[1].replace(/<[^>]*>/g, "").trim());
			const displayTitle = english || jname;
			const watchUrl = hrefMatch ? hrefMatch[1].trim() : "";
			const poster = imgMatch ? imgMatch[1].trim() : "";
			const cleanUrl = (watchUrl || "").split("?")[0].replace(/\/$/, "");
			const idMatch = cleanUrl.match(/-(\d+)$/) || cleanUrl.match(/\/(\d+)$/) || slide.match(/data-id="(\d+)"/);
			const cleanDisplay = displayTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
			const matchedFeatured = FEATURED_ANIME.find((f) => {
				const fEnglish = (f.title?.english || "").toLowerCase().replace(/[^a-z0-9]/g, "");
				const fRomaji = (f.title?.romaji || "").toLowerCase().replace(/[^a-z0-9]/g, "");
				return cleanDisplay && (cleanDisplay === fEnglish || cleanDisplay === fRomaji);
			});
			const id = idMatch ? idMatch[1] : matchedFeatured?.hianimeId || matchedFeatured?.id;
			if (!id) continue;
			const finalPoster = poster || matchedFeatured?.coverImage?.extraLarge || matchedFeatured?.coverImage?.large || "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg";
			trending.push({
				id: Number(id) || id,
				hianimeId: String(id),
				rank,
				title: {
					english: displayTitle,
					romaji: jname || displayTitle,
					userPreferred: displayTitle
				},
				titleStr: displayTitle,
				coverImage: {
					extraLarge: finalPoster,
					large: finalPoster,
					medium: finalPoster
				},
				poster: finalPoster,
				bannerImage: matchedFeatured?.bannerImage || finalPoster,
				format: "TV",
				episodes: 24,
				subCount: 24,
				dubCount: 12,
				trendingScore: Math.round((99.8 - (rank - 1) * .9) * 10) / 10,
				neonColor: rank % 3 === 1 ? "rgba(255, 59, 107, 0.85)" : rank % 3 === 2 ? "rgba(129, 140, 248, 0.85)" : "rgba(6, 182, 212, 0.85)",
				url: watchUrl.startsWith("http") ? watchUrl : `${BASE_URL}${watchUrl}`,
				syncedAt: Date.now()
			});
		}
	} catch (e) {}
	return trending;
}
async function runHiAnimeSync() {
	if (syncState.isSyncing) {
		logSync("Sync is already running in background, skipping duplicate run.");
		return syncState;
	}
	syncState.isSyncing = true;
	syncState.lastError = null;
	logSync("Starting complete HiAnime catalog sync...");
	const allAnimeMap = /* @__PURE__ */ new Map();
	const categoriesData = {};
	try {
		logSync("Fetching https://hianime.at/home...");
		const homeRes = await fetch(`${BASE_URL}/home`, {
			headers: {
				"User-Agent": UA,
				Accept: "text/html,application/xhtml+xml,*/*"
			},
			signal: AbortSignal.timeout(12e3)
		});
		if (homeRes.ok) {
			const homeHtml = await homeRes.text();
			const spotlights = parseHiAnimeSpotlights(homeHtml);
			const trendingItems = parseHiAnimeTrending(homeHtml);
			const homeCards = parseHiAnimeCards(homeHtml, "home");
			if (spotlights.length > 0) {
				syncState.data.spotlight = spotlights;
				spotlights.forEach((a) => allAnimeMap.set(String(a.id), a));
				logSync(`Extracted ${spotlights.length} spotlight anime banners from HiAnime.`);
			}
			if (trendingItems.length > 0) {
				syncState.data.trending = trendingItems;
				trendingItems.forEach((a) => allAnimeMap.set(String(a.id), a));
				logSync(`Extracted ${trendingItems.length} live trending items from HiAnime (#trending-home).`);
			} else if (homeCards.length > 0) syncState.data.trending = homeCards.slice(0, 12).map((a, i) => ({
				...a,
				rank: i + 1,
				trendingScore: Math.round((99.5 - i * 2.1) * 10) / 10,
				neonColor: i % 3 === 0 ? "rgba(255, 59, 107, 0.85)" : i % 3 === 1 ? "rgba(129, 140, 248, 0.85)" : "rgba(6, 182, 212, 0.85)"
			}));
			homeCards.forEach((a) => allAnimeMap.set(String(a.id), a));
		}
		const targetCategories = [
			{
				name: "latestEpisodes",
				url: `${BASE_URL}/recently-updated`
			},
			{
				name: "topAiring",
				url: `${BASE_URL}/top-airing`
			},
			{
				name: "mostPopular",
				url: `${BASE_URL}/most-popular`
			},
			{
				name: "mostFavorite",
				url: `${BASE_URL}/most-favorite`
			},
			{
				name: "latestCompleted",
				url: `${BASE_URL}/completed`
			},
			{
				name: "topUpcoming",
				url: `${BASE_URL}/top-upcoming`
			},
			{
				name: "subbedAnime",
				url: `${BASE_URL}/subbed-anime`
			},
			{
				name: "dubbedAnime",
				url: `${BASE_URL}/dubbed-anime`
			},
			{
				name: "movies",
				url: `${BASE_URL}/movie`
			},
			{
				name: "tvSeries",
				url: `${BASE_URL}/tv`
			},
			{
				name: "recentlyAdded",
				url: `${BASE_URL}/recently-added`
			},
			{
				name: "azList1",
				url: `${BASE_URL}/az-list?page=1`
			},
			{
				name: "azList2",
				url: `${BASE_URL}/az-list?page=2`
			},
			{
				name: "azList3",
				url: `${BASE_URL}/az-list?page=3`
			},
			{
				name: "azList4",
				url: `${BASE_URL}/az-list?page=4`
			},
			{
				name: "azList5",
				url: `${BASE_URL}/az-list?page=5`
			}
		];
		for (const cat of targetCategories) try {
			logSync(`Scraping category "${cat.name}" from ${cat.url}...`);
			const res = await fetch(cat.url, {
				headers: {
					"User-Agent": UA,
					Accept: "text/html,*/*"
				},
				signal: AbortSignal.timeout(1e4)
			});
			if (res.ok) {
				const items = parseHiAnimeCards(await res.text(), cat.name);
				categoriesData[cat.name] = items;
				items.forEach((a) => allAnimeMap.set(String(a.id), a));
				logSync(`Scraped ${items.length} anime from "${cat.name}".`);
			}
		} catch (err) {
			logSync(`Warning: Category "${cat.name}" fetch failed: ${err.message}`);
		}
		if (categoriesData.latestEpisodes && categoriesData.latestEpisodes.length > 0) syncState.data.latestEpisodes = categoriesData.latestEpisodes;
		if (categoriesData.topAiring && categoriesData.topAiring.length > 0) syncState.data.topAiring = categoriesData.topAiring;
		if (categoriesData.mostPopular && categoriesData.mostPopular.length > 0) syncState.data.mostPopular = categoriesData.mostPopular;
		if (categoriesData.mostFavorite && categoriesData.mostFavorite.length > 0) syncState.data.mostFavorite = categoriesData.mostFavorite;
		if (categoriesData.latestCompleted && categoriesData.latestCompleted.length > 0) syncState.data.latestCompleted = categoriesData.latestCompleted;
		if (categoriesData.topUpcoming && categoriesData.topUpcoming.length > 0) syncState.data.topUpcoming = categoriesData.topUpcoming;
		syncState.data.categories = categoriesData;
		syncState.data.allAnime = Array.from(allAnimeMap.values());
		syncState.totalAnimeCount = syncState.data.allAnime.length;
		syncState.lastSyncTime = Date.now();
		syncState.nextSyncTime = syncState.lastSyncTime + SYNC_INTERVAL_MS;
		logSync(`✅ HiAnime Sync Success! Total unique anime cached: ${syncState.totalAnimeCount}`);
		try {
			if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
			writeFileSync(CACHE_FILE, JSON.stringify(syncState, null, 2), "utf8");
			logSync(`Saved synced payload to ${CACHE_FILE}`);
		} catch (saveErr) {
			logSync(`Warning: Failed to save disk cache: ${saveErr.message}`);
		}
	} catch (err) {
		syncState.lastError = err.message;
		logSync(`❌ HiAnime Sync Error: ${err.message}`);
	} finally {
		syncState.isSyncing = false;
	}
	return syncState;
}
function getSyncedHiAnimeData() {
	return syncState;
}

// Hydrate the in-memory catalog from data/hianime-cache.json. The serverless
// deployment only runs the sync timer from server.js, so without this the
// catalog stayed empty on cold starts (search, A-Z and every language feed
// rendered nothing).
function loadHiAnimeCacheFromDisk() {
	try {
		if (!existsSync(CACHE_FILE)) return false;
		const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
		if (!parsed || typeof parsed !== "object") return false;

		const data = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
		if (!data || typeof data !== "object") return false;

		syncState.data = { ...syncState.data, ...data };
		syncState.totalAnimeCount = parsed.totalAnimeCount ?? (syncState.data.allAnime || []).length;
		syncState.lastSyncTime = parsed.lastSyncTime || syncState.lastSyncTime || 0;
		syncState.nextSyncTime = syncState.lastSyncTime ? syncState.lastSyncTime + SYNC_INTERVAL_MS : 0;
		if (Array.isArray(parsed.syncLogs)) syncState.syncLogs = parsed.syncLogs.slice(0, 20);

		logSync(`Loaded ${(syncState.data.allAnime || []).length} cached HiAnime items from disk.`);
		return true;
	} catch (err) {
		logSync(`Warning: failed to load disk cache: ${err.message}`);
		return false;
	}
}

// Boot hook for the dev server: hydrate the cache, refresh it when stale and
// keep it fresh on a 6-hour timer.
function initHiAnimeSyncEngine() {
	loadHiAnimeCacheFromDisk();

	const ageMs = syncState.lastSyncTime ? Date.now() - syncState.lastSyncTime : Infinity;
	const fresh = ageMs < SYNC_INTERVAL_MS;

	if (fresh) {
		logSync(`Cache is fresh (synced ${Math.round(ageMs / 60000)} mins ago).`);
	} else {
		runHiAnimeSync().catch((err) => logSync(`Initial sync failed: ${err.message}`));
	}

	setInterval(() => {
		runHiAnimeSync().catch((err) => logSync(`Scheduled sync failed: ${err.message}`));
	}, SYNC_INTERVAL_MS);

	logSync(`Scheduled recurring HiAnime auto-sync every 6 hours (${SYNC_INTERVAL_MS}ms).`);
}
function searchSyncedAnime(query) {
	if (!query || typeof query !== "string") return [];
	const q = query.trim().toLowerCase();
	return (syncState.data.allAnime || []).filter((a) => {
		const tEng = (a.title?.english || "").toLowerCase();
		const tRom = (a.title?.romaji || "").toLowerCase();
		const tStr = (a.titleStr || "").toLowerCase();
		return tEng.includes(q) || tRom.includes(q) || tStr.includes(q);
	});
}
function getSyncedAnimeByLetter(char) {
	const all = syncState.data.allAnime || [];
	if (char === "All") return all;
	if (char === "0-9") return all.filter((a) => /^[0-9]/.test((a.titleStr || "").trim()));
	const lower = char.toLowerCase();
	return all.filter((a) => (a.titleStr || "").trim().toLowerCase().startsWith(lower));
}

//#endregion
export {
	getSyncedAnimeByLetter,
	getSyncedHiAnimeData,
	initHiAnimeSyncEngine,
	loadHiAnimeCacheFromDisk,
	runHiAnimeSync,
	searchSyncedAnime
};