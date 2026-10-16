import "./anilist.js";

//#region core/anime-service.js
const ANILIST_URL = "https://graphql.anilist.co";
const FEATURED_ANIME = [
	{
		id: 154587,
		hianimeId: "481",
		title: {
			english: "Frieren: Beyond Journey's End",
			romaji: "Sousou no Frieren"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx154587-qQTzQnEJJ3oB.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/154587-ivXNJ23SM1xB.jpg",
		description: "The adventure is over but life goes on for an elf mage just beginning to learn what living is all about. The elf mage Frieren and her courageous fellow adventurers have defeated the Demon King and brought peace to the land. But Frieren will long outlive the rest of her party.",
		genres: [
			"Adventure",
			"Drama",
			"Fantasy"
		],
		averageScore: 91,
		episodes: 28,
		seasonYear: 2023,
		status: "FINISHED",
		featuredBadge: "Masterpiece of the Decade"
	},
	{
		id: 151807,
		hianimeId: "235",
		title: {
			english: "Solo Leveling",
			romaji: "Ore dake Level Up na Ken"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx151807-it355ZgzquUd.png",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx151807-it355ZgzquUd.png"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/151807-35eaZ8c01iQy.jpg",
		description: "They say whatever doesn't kill you makes you stronger, but that's not the case for the world's weakest hunter Sung Jinwoo. After being brutally slaughtered by monsters in a high-ranking dungeon, Jinwoo came back with the System, a program only he can see, that's leveling him up in every way.",
		genres: [
			"Action",
			"Adventure",
			"Fantasy"
		],
		averageScore: 83,
		episodes: 12,
		seasonYear: 2024,
		status: "FINISHED",
		featuredBadge: "Trending Global Sensation"
	},
	{
		id: 101922,
		hianimeId: "843",
		title: {
			english: "Demon Slayer: Kimetsu no Yaiba",
			romaji: "Kimetsu no Yaiba"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx101922-WBsBl0ClmgYL.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/101922-33MtJGsUSxga.jpg",
		description: "It is the Taisho Period in Japan. Tanjiro, a kindhearted boy who sells charcoal for a living, finds his family slaughtered by a demon. Nezuko, the sole survivor, has been transformed into a demon herself. Tanjiro resolves to become a demon slayer to turn his sister back into a human.",
		genres: [
			"Action",
			"Adventure",
			"Fantasy",
			"Supernatural"
		],
		averageScore: 82,
		episodes: 26,
		seasonYear: 2019,
		status: "FINISHED",
		featuredBadge: "Peak Animation & Battles"
	},
	{
		id: 113415,
		hianimeId: "237",
		title: {
			english: "Jujutsu Kaisen",
			romaji: "Jujutsu Kaisen"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx113415-LHBAeoZDIsnF.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/113415-jQWSGQb0HXrn.jpg",
		description: "A boy swallowed a cursed talisman - the demon Sukuna's finger - and became cursed himself. He enters a shaman's school to be able to locate the demon's other body parts and thus exorcise himself.",
		genres: [
			"Action",
			"Fantasy",
			"Supernatural"
		],
		averageScore: 85,
		episodes: 24,
		seasonYear: 2020,
		status: "FINISHED",
		featuredBadge: "Highest Rated Shonen"
	},
	{
		id: 21,
		hianimeId: "1",
		title: {
			english: "One Piece",
			romaji: "ONE PIECE"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21-ELSYx3yMPcKM.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21-wf37VakJdeZl.jpg",
		description: "Gold Roger was known as the 'Pirate King', the strongest and most infamous being to have sailed the Grand Line. Monkey D. Luffy, a 17-year-old boy that defies your standard definition of a pirate, journeys to claim the legendary treasure One Piece.",
		genres: [
			"Action",
			"Adventure",
			"Comedy",
			"Fantasy"
		],
		averageScore: 88,
		episodes: 1100,
		seasonYear: 1999,
		status: "RELEASING",
		featuredBadge: "Timeless Masterpiece"
	},
	{
		id: 16498,
		hianimeId: "240",
		title: {
			english: "Attack on Titan",
			romaji: "Shingeki no Kyojin"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx16498-buvcRTBx4NSm.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/16498-73IhOXhnKU2w.jpg",
		description: "Centuries ago, mankind was slaughtered to near extinction by monstrous humanoid creatures called Titans. Eren Yeager vows to eliminate every Titan after experiencing a catastrophic loss.",
		genres: [
			"Action",
			"Drama",
			"Fantasy",
			"Mystery"
		],
		averageScore: 85,
		episodes: 25,
		seasonYear: 2013,
		status: "FINISHED",
		featuredBadge: "Legendary Dark Epic"
	},
	{
		id: 127230,
		hianimeId: "236",
		title: {
			english: "Chainsaw Man",
			romaji: "Chainsaw Man"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx127230-DdP4vAdssLoz.png",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx127230-DdP4vAdssLoz.png"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/127230-6P4kJsqWzqq5.jpg",
		description: "Denji is a young man living a poverty-stricken life while paying off his deceased father's debt to the yakuza by working as a devil hunter alongside Pochita, the Chainsaw Devil.",
		genres: [
			"Action",
			"Comedy",
			"Drama",
			"Horror",
			"Supernatural"
		],
		averageScore: 84,
		episodes: 12,
		seasonYear: 2022,
		status: "FINISHED"
	},
	{
		id: 140960,
		hianimeId: "639",
		title: {
			english: "Spy x Family",
			romaji: "SPY×FAMILY"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx140960-Kb6R5nYQfjmP.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx140960-Kb6R5nYQfjmP.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/140960-2t8p6V4J5b7T.jpg",
		description: "World peace is at stake and secret agent Twilight must undergo his most difficult mission yet: pretend to be a family man. Posing as the loving husband and father, he will infiltrate an elite school.",
		genres: [
			"Action",
			"Comedy",
			"Slice of Life"
		],
		averageScore: 84,
		episodes: 12,
		seasonYear: 2022,
		status: "FINISHED"
	},
	{
		id: 101348,
		hianimeId: "901",
		title: {
			english: "Vinland Saga",
			romaji: "VINLAND SAGA"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101348-2fhDFPCuMNiz.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx101348-2fhDFPCuMNiz.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/101348-7Pj2x7J4mR5E.jpg",
		description: "Raised by the Vikings who murdered his family after they attacked his land, Thorfinn became a terrifying warrior, who forever seeks to kill the band's leader, Askeladd, and avenge his father.",
		genres: [
			"Action",
			"Adventure",
			"Drama"
		],
		averageScore: 87,
		episodes: 24,
		seasonYear: 2019,
		status: "FINISHED"
	},
	{
		id: 1535,
		hianimeId: "1064",
		title: {
			english: "Death Note",
			romaji: "DEATH NOTE"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1535-kUgkcrfOrkUM.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx1535-kUgkcrfOrkUM.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/1535-434x8R7Lq5fM.jpg",
		description: "A high-school student who discovers a supernatural notebook that grants its user the ability to kill anyone whose name and face they know.",
		genres: [
			"Mystery",
			"Psychological",
			"Supernatural",
			"Thriller"
		],
		averageScore: 84,
		episodes: 37,
		seasonYear: 2006,
		status: "FINISHED"
	},
	{
		id: 5114,
		hianimeId: "1140",
		title: {
			english: "Fullmetal Alchemist: Brotherhood",
			romaji: "Hagane no Renkinjutsushi: Fullmetal Alchemist"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-nSWCgQlmOMtj.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx5114-nSWCgQlmOMtj.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/5114-601J8a0X8N9B.jpg",
		description: "Two brothers search for a Philosopher's Stone after an attempt to revive their deceased mother goes wrong and leaves them in damaged physical forms.",
		genres: [
			"Action",
			"Adventure",
			"Drama",
			"Fantasy"
		],
		averageScore: 90,
		episodes: 64,
		seasonYear: 2009,
		status: "FINISHED"
	},
	{
		id: 11061,
		hianimeId: "1393",
		title: {
			english: "Hunter x Hunter (2011)",
			romaji: "HUNTER×HUNTER (2011)"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx11061-y5gsT1hoHuHw.png",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx11061-y5gsT1hoHuHw.png"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/11061-8041a7q09E1T.jpg",
		description: "Gon Freecss aspires to become a Hunter, an exceptional being capable of greatness. With his friends and his potential, he seeks out his father, who left him when he was younger.",
		genres: [
			"Action",
			"Adventure",
			"Fantasy"
		],
		averageScore: 89,
		episodes: 148,
		seasonYear: 2011,
		status: "FINISHED"
	},
	{
		id: 150672,
		hianimeId: "277",
		title: {
			english: "Oshi no Ko",
			romaji: "[Oshi no Ko]"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx150672-WqmmwZ4nMzAy.png",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx150672-WqmmwZ4nMzAy.png"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/150672-dGg9p1s9Q1c8.jpg",
		description: "A doctor and his recently-deceased patient are reborn as twins to a famous Japanese musical idol and navigate the highs and lows of the country's entertainment industry as they grow up together.",
		genres: [
			"Drama",
			"Mystery",
			"Psychological",
			"Supernatural"
		],
		averageScore: 84,
		episodes: 11,
		seasonYear: 2023,
		status: "FINISHED"
	},
	{
		id: 120377,
		hianimeId: "1048",
		title: {
			english: "Cyberpunk: Edgerunners",
			romaji: "Cyberpunk: Edgerunners"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx120377-ayZPoxiWt4Li.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx120377-ayZPoxiWt4Li.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/120377-3e1s8q01lG2q.jpg",
		description: "A street kid trying to survive in a technology and body modification-obsessed city of the future. Having everything to lose, he chooses to stay alive by becoming an edgerunner.",
		genres: [
			"Action",
			"Drama",
			"Sci-Fi"
		],
		averageScore: 86,
		episodes: 10,
		seasonYear: 2022,
		status: "FINISHED"
	},
	{
		id: 130003,
		hianimeId: "969",
		title: {
			english: "Bocchi the Rock!",
			romaji: "Bocchi the Rock!"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx130003-HTDmeL4RGeJ4.png",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx130003-HTDmeL4RGeJ4.png"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/130003-1u9V3d8a5q1n.jpg",
		description: "Hitori Gotou is a high school girl who's starting to learn to play the guitar because she dreams of being in a band, but she's so shy that she hasn't made a single friend.",
		genres: [
			"Comedy",
			"Music",
			"Slice of Life"
		],
		averageScore: 87,
		episodes: 12,
		seasonYear: 2022,
		status: "FINISHED"
	},
	{
		id: 269,
		hianimeId: "1369",
		title: {
			english: "Bleach",
			romaji: "BLEACH"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx269-d2GmRkJbMopq.png",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx269-d2GmRkJbMopq.png"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/269-5q7x0v9a3b7p.jpg",
		description: "Ichigo Kurosaki is a teenager who can see ghosts, a talent which lets him meet supernatural stranger Rukia Kuchiki and become a Soul Reaper.",
		genres: [
			"Action",
			"Adventure",
			"Supernatural"
		],
		averageScore: 79,
		episodes: 366,
		seasonYear: 2004,
		status: "FINISHED"
	},
	{
		id: 9253,
		hianimeId: "872",
		title: {
			english: "Steins;Gate",
			romaji: "Steins;Gate"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9253-tIUXF2gfU8Sg.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx9253-tIUXF2gfU8Sg.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/9253-764n1x0p3m2w.jpg",
		description: "An eccentric scientist discovers how to send messages to the past, altering the timeline and endangering his closest friends.",
		genres: [
			"Drama",
			"Psychological",
			"Sci-Fi",
			"Thriller"
		],
		averageScore: 89,
		episodes: 24,
		seasonYear: 2011,
		status: "FINISHED"
	},
	{
		id: 171018,
		hianimeId: "86",
		title: {
			english: "DAN DA DAN",
			romaji: "Dandadan"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx171018-60q1B6GK2Ghb.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx171018-60q1B6GK2Ghb.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/171018-2e8j9q01a4b6.jpg",
		description: "Momo Ayase, who believes in ghosts, and Okarun, who believes in aliens, wager to prove the other wrong and encounter unimaginable supernatural phenomena.",
		genres: [
			"Action",
			"Comedy",
			"Romance",
			"Sci-Fi",
			"Supernatural"
		],
		averageScore: 86,
		episodes: 12,
		seasonYear: 2024,
		status: "FINISHED"
	},
	{
		id: 153288,
		hianimeId: "257",
		title: {
			english: "Kaiju No. 8",
			romaji: "Kaijuu 8-gou"
		},
		coverImage: {
			extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx153288-25FBfFJzEQ5O.jpg",
			large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx153288-25FBfFJzEQ5O.jpg"
		},
		bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/153288-5r4A4uGg1W9e.jpg",
		description: "In a world plagued by terrifying creatures known as Kaiju, Kafka Hibino always aspired to enlist in The Defense Force. Instead, he ended up in a cleaning company that disposes of dead monsters. But after a strange encounter with a small Kaiju transforms his body, Kafka gains the power of a Kaiju himself.",
		genres: ["Action", "Sci-Fi"],
		averageScore: 82,
		episodes: 12,
		seasonYear: 2024,
		status: "FINISHED"
	}
];
async function refreshFeaturedAnimeCovers() {
	try {
		const ids = FEATURED_ANIME.map((a) => a.id);
		const query = `
      query($ids: [Int]) {
        Page(page: 1, perPage: 50) {
          media(id_in: $ids) {
            id
            coverImage { extraLarge large medium }
            bannerImage
          }
        }
      }
    `;
		const res = await fetch(ANILIST_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json"
			},
			body: JSON.stringify({
				query,
				variables: { ids }
			}),
			signal: AbortSignal.timeout(6e3)
		});
		if (!res.ok) return;
		const list = (await res.json())?.data?.Page?.media || [];
		for (const item of list) {
			const target = FEATURED_ANIME.find((a) => a.id === item.id);
			if (target && item.coverImage) {
				if (item.coverImage.extraLarge) target.coverImage.extraLarge = item.coverImage.extraLarge;
				if (item.coverImage.large) target.coverImage.large = item.coverImage.large;
				if (item.bannerImage) target.bannerImage = item.bannerImage;
			}
		}
	} catch (err) {
		console.warn("Cover refresh non-fatal error:", err.message);
	}
}
refreshFeaturedAnimeCovers();
const searchCache = /* @__PURE__ */ new Map();
const detailsCache = /* @__PURE__ */ new Map();
async function searchAnime(query) {
	if (!query || typeof query !== "string") return [];
	const cleanQ = query.trim().toLowerCase();
	if (!cleanQ) return FEATURED_ANIME.slice(0, 10);
	if (searchCache.has(cleanQ)) return searchCache.get(cleanQ);
	const localMatches = FEATURED_ANIME.filter((a) => a.title.english?.toLowerCase().includes(cleanQ) || a.title.romaji?.toLowerCase().includes(cleanQ) || a.genres.some((g) => g.toLowerCase().includes(cleanQ)));
	try {
		const gql = `
      query ($search: String) {
        Page(page: 1, perPage: 16) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
            id
            title { english romaji native }
            coverImage { extraLarge large }
            bannerImage
            description
            genres
            averageScore
            episodes
            seasonYear
            status
          }
        }
      }
    `;
		const res = await fetch(ANILIST_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json"
			},
			body: JSON.stringify({
				query: gql,
				variables: { search: query }
			}),
			signal: AbortSignal.timeout(5e3)
		});
		if (res.ok) {
			const formatted = ((await res.json())?.data?.Page?.media || []).map((m) => ({
				id: m.id,
				title: {
					english: m.title.english || m.title.romaji,
					romaji: m.title.romaji
				},
				coverImage: m.coverImage,
				bannerImage: m.bannerImage,
				description: (m.description || "").replace(/<[^>]*>?/gm, ""),
				genres: m.genres || [],
				averageScore: m.averageScore || 0,
				episodes: m.episodes || 0,
				seasonYear: m.seasonYear || 0,
				status: m.status || "UNKNOWN"
			}));
			const seen = /* @__PURE__ */ new Set();
			const combined = [];
			for (const item of [...localMatches, ...formatted]) if (!seen.has(item.id)) {
				seen.add(item.id);
				combined.push(item);
			}
			searchCache.set(cleanQ, combined);
			return combined;
		}
	} catch (err) {
		console.warn("AniList search API failed, using local match:", err.message);
	}
	return localMatches;
}
async function getAnimeById(id) {
	const numId = Number(id);
	if (!numId) return null;
	if (detailsCache.has(numId)) return detailsCache.get(numId);
	const local = FEATURED_ANIME.find((a) => a.id === numId || String(a.hianimeId) === String(id));
	if (local) return local;
	try {
		const gql = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          title { english romaji native }
          coverImage { extraLarge large }
          bannerImage
          description
          genres
          averageScore
          episodes
          seasonYear
          status
        }
      }
    `;
		const res = await fetch(ANILIST_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json"
			},
			body: JSON.stringify({
				query: gql,
				variables: { id: numId }
			}),
			signal: AbortSignal.timeout(5e3)
		});
		if (res.ok) {
			const m = (await res.json())?.data?.Media;
			if (m) {
				const item = {
					id: m.id,
					title: {
						english: m.title.english || m.title.romaji,
						romaji: m.title.romaji
					},
					coverImage: m.coverImage,
					bannerImage: m.bannerImage,
					description: (m.description || "").replace(/<[^>]*>?/gm, ""),
					genres: m.genres || [],
					averageScore: m.averageScore || 0,
					episodes: m.episodes || 0,
					seasonYear: m.seasonYear || 0,
					status: m.status || "UNKNOWN"
				};
				detailsCache.set(numId, item);
				return item;
			}
		}
	} catch (err) {
		console.warn("AniList detail API failed:", err.message);
	}
	return null;
}

//#endregion
export { FEATURED_ANIME, getAnimeById, searchAnime };