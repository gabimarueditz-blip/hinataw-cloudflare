import { extractMegaPlayDetails } from "../extractors/megaplay.js";

//#region core/hianime-service.js
const BASE_URL = "https://hianime.at";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const cache = /* @__PURE__ */ new Map();
const TTL = 1e3 * 60 * 15;
function decodeEntities(str) {
	return (str || "").replace(/&#039;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function getCached(key) {
	const item = cache.get(key);
	if (item && Date.now() - item.time < TTL) return item.data;
	return null;
}
function setCached(key, data) {
	cache.set(key, {
		time: Date.now(),
		data
	});
}
async function searchHiAnime(keyword, page = 1) {
	if (!keyword || typeof keyword !== "string") return [];
	const cacheKey = `search:${keyword.trim().toLowerCase()}:${page}`;
	const hit = getCached(cacheKey);
	if (hit) return hit;
	const url = `${BASE_URL}/browse?keyword=${encodeURIComponent(keyword.trim())}&page=${page}`;
	try {
		const res = await fetch(url, {
			headers: {
				"User-Agent": UA,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
			},
			signal: AbortSignal.timeout(6e3)
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const results = parseFilmItems(await res.text());
		setCached(cacheKey, results);
		return results;
	} catch (err) {
		console.error("searchHiAnime error:", err.message);
		return [];
	}
}
async function browseHiAnime(category = "most-popular", page = 1) {
	const cat = [
		"most-popular",
		"subbed-anime",
		"dubbed-anime",
		"tv",
		"movie",
		"ova",
		"ona",
		"az-list"
	].includes(category) ? category : "most-popular";
	const cacheKey = `browse:${cat}:${page}`;
	const hit = getCached(cacheKey);
	if (hit) return hit;
	const url = `${BASE_URL}/${cat}?page=${page}`;
	try {
		const res = await fetch(url, {
			headers: {
				"User-Agent": UA,
				Accept: "text/html,*/*"
			},
			signal: AbortSignal.timeout(6e3)
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const results = parseFilmItems(await res.text());
		setCached(cacheKey, results);
		return results;
	} catch (err) {
		console.error("browseHiAnime error:", err.message);
		return [];
	}
}
async function getHiAnimeEpisodes(animeId) {
	if (!animeId) return [];
	const cleanId = String(animeId).trim();
	const cacheKey = `episodes:${cleanId}`;
	const hit = getCached(cacheKey);
	if (hit) return hit;
	const url = `${BASE_URL}/api/theme/episode/list/${cleanId}`;
	try {
		const res = await fetch(url, {
			headers: {
				"User-Agent": UA,
				Accept: "application/json, text/javascript, */*; q=0.01",
				"X-Requested-With": "XMLHttpRequest",
				Referer: `${BASE_URL}/watch/${cleanId}`
			},
			signal: AbortSignal.timeout(8e3)
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = await res.json();
		if (!json || !json.html) return [];
		const epRegex = /<a[^>]*class="[^"]*ep-item[^"]*"[^>]*data-number="([^"]+)"[^>]*data-id="([^"]+)"[^>]*href="([^"]+)"[\s\S]*?<div class="ep-name[^"]*"[^>]*data-jname="([^"]*)"[^>]*title="([^"]*)"/g;
		let match;
		const episodes = [];
		while (match = epRegex.exec(json.html)) {
			const epNum = parseInt(match[1], 10);
			const epId = match[2];
			const watchUrl = match[3];
			const jname = decodeEntities(match[4] || "");
			const englishTitle = decodeEntities(match[5] || "");
			let displayTitle = englishTitle || jname || `Episode ${epNum}`;
			if (displayTitle === `Episode ${epNum}` && jname && jname !== `Episode ${epNum}`) displayTitle = jname;
			episodes.push({
				episode: epNum,
				episodeId: epId,
				title: decodeEntities(displayTitle),
				japaneseTitle: jname,
				englishTitle,
				url: watchUrl.startsWith("http") ? watchUrl : `${BASE_URL}${watchUrl}`
			});
		}
		setCached(cacheKey, episodes);
		return episodes;
	} catch (err) {
		console.error("getHiAnimeEpisodes error:", err.message);
		return [];
	}
}
async function getAnimeWithEpisodes(queryOrId) {
	let targetAnime = null;
	if (/^\d+$/.test(String(queryOrId))) {
		const episodes = await getHiAnimeEpisodes(queryOrId);
		return {
			id: queryOrId,
			title: episodes[0]?.title || `Series #${queryOrId}`,
			totalEpisodes: episodes.length,
			episodes
		};
	}
	const searchResults = await searchHiAnime(queryOrId);
	if (searchResults.length > 0) {
		targetAnime = searchResults[0];
		const episodes = await getHiAnimeEpisodes(targetAnime.id);
		return {
			...targetAnime,
			totalEpisodes: episodes.length,
			episodes
		};
	}
	return null;
}
async function getHiAnimeEpisodeStream(episodeId, audio = "sub") {
	if (!episodeId) throw new Error("Missing episodeId");
	const cleanEpId = String(episodeId).trim();
	const cacheKey = `stream:${cleanEpId}:${audio}`;
	const hit = getCached(cacheKey);
	if (hit) return hit;
	const url = `${BASE_URL}/api/theme/episode/servers?episodeId=${cleanEpId}`;
	const res = await fetch(url, {
		headers: {
			"User-Agent": UA,
			Accept: "application/json, text/javascript, */*; q=0.01",
			"X-Requested-With": "XMLHttpRequest",
			Referer: `${BASE_URL}/watch/anime-${cleanEpId}`
		},
		signal: AbortSignal.timeout(6e3)
	});
	if (!res.ok) throw new Error(`Failed to fetch servers for episode ${cleanEpId}`);
	const json = await res.json();
	if (!json || !json.html) throw new Error("Empty server list returned by HiAnime");
	const regex = /<div class="item server-item" data-type="([^"]+)"\s+data-server-name="([^"]+)"\s+data-hash="([^"]+)"/g;
	let m;
	const servers = [];
	while (m = regex.exec(json.html)) {
		const type = m[1];
		const name = m[2];
		const hash = m[3];
		try {
			const rawUrl = Buffer.from(hash, "base64").toString("utf8");
			servers.push({
				type,
				name,
				rawUrl
			});
		} catch {}
	}
	const audioServers = servers.filter((s) => s.type.toLowerCase() === audio.toLowerCase());
	const chosenServers = audioServers.length > 0 ? audioServers : servers;
	const streams = [];
	const OBF_KEY = "otaku-embed-v1";
	function deobf(blob) {
		try {
			let out = "";
			const bin = Buffer.from(blob, "base64").toString("binary");
			for (let i = 0; i < bin.length; i++) out += String.fromCharCode(bin.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % 14));
			return JSON.parse(decodeURIComponent(escape(out)));
		} catch {
			return null;
		}
	}
	for (const s of chosenServers) {
		if (s.rawUrl.includes("zokoanime") || s.name.toLowerCase().includes("zoko")) try {
			const zokoRes = await fetch(s.rawUrl, {
				headers: {
					"User-Agent": UA,
					Referer: `${BASE_URL}/`
				},
				signal: AbortSignal.timeout(3500)
			});
			if (zokoRes.ok) {
				const pMatch = (await zokoRes.text()).match(/window\.__P="([^"]+)"/);
				if (pMatch) {
					const dec = deobf(pMatch[1]);
					if (dec && dec.src) {
						streams.unshift({
							server: `Direct HD ⚡ (${s.type.toUpperCase()})`,
							type: "hls",
							url: dec.src,
							referer: "https://zokoanime.video/",
							subtitles: (dec.subtitles || []).map((t, idx) => ({
								url: t.src,
								label: t.label || `Subtitle ${idx + 1}`,
								srclang: t.lang || "en",
								default: !!t.default
							}))
						});
						continue;
					}
				}
			}
		} catch (zErr) {
			console.warn("HiAnime Zoko extraction note:", zErr.message);
		}
		if (s.rawUrl.includes("megaplay.buzz")) try {
			const details = await extractMegaPlayDetails(s.rawUrl, {
				userAgent: UA,
				referer: "https://hianimes.re/"
			});
			if (details && details.sources && details.sources.length > 0) for (const src of details.sources) streams.push({
				server: `${s.name} (${s.type.toUpperCase()})`,
				type: "hls",
				url: src.url,
				embedUrl: s.rawUrl,
				referer: "https://megaplay.buzz/",
				subtitles: (details.tracks || []).map((t) => ({
					url: t.file,
					label: t.label,
					srclang: t.label?.toLowerCase()?.slice(0, 2) || "en",
					default: !!t.default
				})),
				intro: details.intro,
				outro: details.outro
			});
		} catch (err) {
			console.warn(`HiAnime extraction failed for ${s.name}:`, err.message);
		}
		streams.push({
			server: `${s.name} (Embed)`,
			type: "embed",
			embedUrl: s.rawUrl,
			url: "",
			subtitles: []
		});
	}
	streams.sort((a, b) => a.type === "hls" ? -1 : b.type === "hls" ? 1 : 0);
	const result = {
		episodeId: cleanEpId,
		audio,
		streams
	};
	setCached(cacheKey, result);
	return result;
}
function parseFilmItems(html) {
	const list = [];
	const cardRegex = /<div class="flw-item[^"]*"[\s\S]*?<img src="([^"]+)"[^>]*alt="([^"]+)"[\s\S]*?<a href="([^"]+)"[^>]*class="film-poster-ahref[^"]*"[^>]*data-id="(\d+)"[\s\S]*?class="dynamic-name"[^>]*>([^<]+)<\/a>/g;
	let match;
	while (match = cardRegex.exec(html)) {
		const poster = match[1];
		const altTitle = match[2].replace(/&#039;/g, "'").replace(/&amp;/g, "&");
		const link = match[3];
		const id = match[4];
		const name = match[5].trim().replace(/&#039;/g, "'").replace(/&amp;/g, "&");
		const slugMatch = link.match(/\/(?:watch\/)?([^/?#]+)/);
		const slug = slugMatch ? slugMatch[1] : link;
		list.push({
			id,
			title: name || altTitle,
			slug,
			url: link.startsWith("http") ? link : `${BASE_URL}${link}`,
			poster
		});
	}
	return list;
}

//#endregion
export { browseHiAnime, getAnimeWithEpisodes, getHiAnimeEpisodeStream, getHiAnimeEpisodes, searchHiAnime };