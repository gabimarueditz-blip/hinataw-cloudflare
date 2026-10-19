// Genga-World API integration - Port to Node.js
// Original Android Kotlin source ported to Node.js for Render deployment
// Target: core/genga-world-api.js

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, ".cache");

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

// ========== GengaWorld API Constants ==========
const GW_BASE_URL = "https://api.gengaworld.example.com"; // Update with actual base URL
const GW_API_VERSION = "v1";

// ========== GengaWorld API Client (Node.js Port) ==========
class GengaWorldApiClient {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || GW_BASE_URL;
    this.apiVersion = config.apiVersion || GW_API_VERSION;
    this.timeout = config.timeout || 30000;
    this.cacheEnabled = config.cacheEnabled !== false;
    this.userAgent = config.userAgent || "GengaWorld-Node-Client/1.0";
  }

  /**
   * Build full API URL
   */
  buildUrl(endpoint, params = {}) {
    const path = `/${this.apiVersion}/${endpoint}`;
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * Make HTTP request with caching
   */
  async request(method, endpoint, options = {}) {
    const { params = {}, body, headers = {}, cacheKey, noCache = false } = options;

    // Check cache first
    if (this.cacheEnabled && !noCache && cacheKey) {
      const cachePath = resolve(CACHE_DIR, `${cacheKey}.json`);
      if (existsSync(cachePath)) {
        try {
          const cached = JSON.parse(readFileSync(cachePath, "utf8"));
          // Simple TTL check (5 minute default)
          const ttl = options.cacheTTL || 300000;
          if (Date.now() - cached.timestamp < ttl) {
            return cached.data;
          }
        } catch {}
      }
    }

    // Build request
    const url = this.buildUrl(endpoint, params);
    const requestHeaders = {
      "User-Agent": this.userAgent,
      "Accept": "application/json",
      "Content-Type": "application/json",
      ...headers,
    };

    const fetchOptions = {
      method,
      headers: requestHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeout),
    };

    if (body && method !== "GET" && method !== "HEAD") {
      fetchOptions.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, fetchOptions);
      const data = await response.json();

      // Cache successful responses
      if (this.cacheEnabled && cacheKey && response.ok) {
        const cachePath = resolve(CACHE_DIR, `${cacheKey}.json`);
        writeFileSync(cachePath, JSON.stringify({
          data,
          timestamp: Date.now(),
        }), "utf8");
      }

      return data;
    } catch (error) {
      console.error(`[GengaWorldApi] Request failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * GET request
   */
  async get(endpoint, options = {}) {
    return this.request("GET", endpoint, options);
  }

  /**
   * POST request
   */
  async post(endpoint, body, options = {}) {
    return this.request("POST", endpoint, { ...options, body });
  }
}

// ========== GengaWorld Movie Catalog API ==========
class GengaWorldMovieApi {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get movie list / catalog
   * Equivalent to Android MovieDao.fetchMovies()
   */
  async getMovieList(page = 1, limit = 20, category = null) {
    const params = {
      page,
      limit,
      ...(category ? { category } : {}),
    };
    return this.client.get("movies", {
      params,
      cacheKey: "movies-list",
      cacheTTL: 600000, // 10 minutes
    });
  }

  /**
   * Get movie details by ID
   * Equivalent to Android MovieDao.getMovieById()
   */
  async getMovieById(movieId) {
    return this.client.get("movies/${movieId}", {
      cacheKey: `movie-${movieId}`,
      cacheTTL: 300000, // 5 minutes
    });
  }

  /**
   * Get movie streams / playback URLs
   * Equivalent to Android MovieDao.getMovieStreams()
   */
  async getMovieStreams(movieId, quality = "1080") {
    const params = { movieId, quality };
    return this.client.get("movies/streams", {
      params,
      cacheKey: `streams-${movieId}-${quality}`,
      cacheTTL: 120000, // 2 minutes
    });
  }

  /**
   * Search movies
   * Equivalent to Android MovieDao.searchMovies()
   */
  async searchMovies(query, page = 1, limit = 20) {
    const params = { q: query, page, limit };
    return this.client.get("movies/search", {
      params,
      cacheKey: `search-${encodeURIComponent(query)}-${page}`,
      cacheTTL: 180000, // 3 minutes
    });
  }

  /**
   * Get trending / popular movies
   */
  async getTrending(limit = 20) {
    return this.client.get("movies/trending", {
      params: { limit },
      cacheKey: "trending-movies",
      cacheTTL: 300000,
    });
  }

  /**
   * Get latest / new releases
   */
  async getLatest(limit = 20) {
    return this.client.get("movies/latest", {
      params: { limit },
      cacheKey: "latest-movies",
      cacheTTL: 180000,
    });
  }
}

// ========== GengaWorld User / Auth API ==========
class GengaWorldUserApi {
  constructor(client) {
    this.client = client;
  }

  /**
   * User login
   * Equivalent to Android AuthManager.login()
   */
  async login(username, password) {
    const body = { username, password };
    const result = await this.client.post("auth/login", body, {
      cacheKey: null, // Never cache auth
      noCache: true,
    });
    // Store token securely (in production, use proper session management)
    if (result.data?.token) {
      this.client.authToken = result.data.token;
      this.client.userAgent = `GengaWorld-Node-Client/1.0 (token: ${result.data.token.substring(0, 10)}...)`;
    }
    return result;
  }

  /**
   * User logout
   */
  async logout() {
    await this.client.get("auth/logout", { noCache: true });
    this.client.authToken = null;
    this.client.userAgent = "GengaWorld-Node-Client/1.0";
  }

  /**
   * Get user profile
   */
  async getProfile() {
    return this.client.get("user/profile", {
      cacheKey: "user-profile",
      cacheTTL: 60000,
    });
  }

  /**
   * Get user watchlist
   */
  async getWatchlist(page = 1, limit = 20) {
    const params = { page, limit };
    return this.client.get("user/watchlist", {
      params,
      cacheKey: "user-watchlist",
      cacheTTL: 120000,
    });
  }

  /**
   * Add movie to watchlist
   */
  async addToWatchlist(movieId) {
    return this.client.post("user/watchlist/add", { movieId }, {
      noCache: true,
    });
  }

  /**
   * Remove movie from watchlist
   */
  async removeFromWatchlist(movieId) {
    return this.client.post("user/watchlist/remove", { movieId }, {
      noCache: true,
    });
  }
}

// ========== GengaWorld Recommendation API ==========
class GengaWorldRecommendationApi {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get personalized recommendations
   */
  async getRecommendations(userId, limit = 20) {
    const params = { userId, limit };
    return this.client.get("recommendations", {
      params,
      cacheKey: `recommendations-${userId}`,
      cacheTTL: 600000,
    });
  }

  /**
   * Get related movies (similar to selected movie)
   */
  async getRelated(movieId, limit = 10) {
    const params = { movieId, limit };
    return this.client.get("movies/related", {
      params,
      cacheKey: `related-${movieId}`,
      cacheTTL: 300000,
    });
  }

  /**
   * Get categories / genres
   */
  async getCategories() {
    return this.client.get("categories", {
      cacheKey: "categories",
      cacheTTL: 600000,
    });
  }

  /**
   * Get movies by category
   */
  async getMoviesByCategory(categoryId, page = 1, limit = 20) {
    const params = { categoryId, page, limit };
    return this.client.get("movies/category", {
      params,
      cacheKey: `category-${categoryId}-${page}`,
      cacheTTL: 300000,
    });
  }
}

// ========== GengaWorld API Router (for Node.js server) ==========
async function handleGengaWorldApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // Parse path segments
  const segments = pathname.split("/").filter(Boolean);

  // Remove /api/gengaworld prefix if present
  if (segments[0] === "api" && segments[1] === "gengaworld") {
    segments.splice(0, 2);
  }

  const result = { success: false, error: null };

  try {
    // Initialize API client
    const apiClient = new GengaWorldApiClient({
      baseUrl: process.env.GW_API_BASE_URL || "https://api.gengaworld.example.com",
      cacheEnabled: process.env.CACHE_ENABLED !== "false",
    });

    // Initialize API services
    const movieApi = new GengaWorldMovieApi(apiClient);
    const userApi = new GengaWorldUserApi(apiClient);
    const recApi = new GengaWorldRecommendationApi(apiClient);

    // Route handling
    if (segments.length === 0 || segments[0] === "home") {
      // Home / catalog endpoint
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "20");

      const [movieList, trending, latest] = await Promise.all([
        movieApi.getMovieList(page, limit),
        movieApi.getTrending(limit),
        movieApi.getLatest(limit),
      ]);

      result.success = true;
      result.data = {
        movies: movieList.data?.movies || movieList.data || [],
        trending: trending.data?.movies || trending.data || [],
        latest: latest.data?.movies || latest.data || [],
      };
    } else if (segments[0] === "movie" && segments[1] === "detail") {
      // Movie detail
      const movieId = url.searchParams.get("id") || segments[2];
      if (!movieId) {
        result.error = "Movie ID required";
        res.statusCode = 400;
        return res.end(JSON.stringify(result));
      }
      const movie = await movieApi.getMovieById(movieId);
      const streams = await movieApi.getMovieStreams(movieId);
      const related = await recApi.getRelated(movieId);

      result.success = true;
      result.data = {
        movie: movie.data?.movie || movie.data || {},
        streams: streams.data?.streams || streams.data || [],
        related: related.data?.movies || related.data || [],
      };
    } else if (segments[0] === "search") {
      // Search
      const query = url.searchParams.get("q") || "";
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "20");

      if (!query) {
        result.error = "Search query required";
        res.statusCode = 400;
        return res.end(JSON.stringify(result));
      }

      const searchResults = await movieApi.searchMovies(query, page, limit);
      result.success = true;
      result.data = {
        results: searchResults.data?.results || searchResults.data || [],
        total: searchResults.data?.total || 0,
      };
    } else if (segments[0] === "categories") {
      // Categories
      const categories = await recApi.getCategories();
      result.success = true;
      result.data = categories.data?.categories || categories.data || [];
    } else if (segments[0] === "category" && segments[1]) {
      // Movies by category
      const categoryId = segments[1];
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "20");

      const movies = await recApi.getMoviesByCategory(categoryId, page, limit);
      result.success = true;
      result.data = {
        category: { id: categoryId },
        movies: movies.data?.movies || movies.data || [],
      };
    } else if (segments[0] === "trending") {
      // Trending
      const limit = parseInt(url.searchParams.get("limit") || "20");
      const trending = await movieApi.getTrending(limit);
      result.success = true;
      result.data = { movies: trending.data?.movies || trending.data || [] };
    } else if (segments[0] === "latest") {
      // Latest
      const limit = parseInt(url.searchParams.get("limit") || "20");
      const latest = await movieApi.getLatest(limit);
      result.success = true;
      result.data = { movies: latest.data?.movies || latest.data || [] };
    } else if (segments[0] === "user" && segments[1] === "watchlist") {
      // User watchlist (requires auth - simplified for now)
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "20");
      const watchlist = await userApi.getWatchlist(page, limit);
      result.success = true;
      result.data = { watchlist: watchlist.data?.watchlist || watchlist.data || [] };
    } else if (segments[0] === "recommendations") {
      // Recommendations (requires user ID)
      const userId = url.searchParams.get("userId") || "default";
      const limit = parseInt(url.searchParams.get("limit") || "20");
      const recommendations = await recApi.getRecommendations(userId, limit);
      result.success = true;
      result.data = { recommendations: recommendations.data?.movies || recommendations.data || [] };
    } else {
      // Unknown route
      result.error = `Unknown GengaWorld endpoint: ${pathname}`;
      res.statusCode = 404;
      return res.end(JSON.stringify(result));
    }
  } catch (error) {
    console.error(`[GengaWorldApi] Route error: ${error.message}`);
    result.error = error.message || "Internal server error";
    res.statusCode = 500;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", result.success ? "public, max-age=60" : "no-store");
  res.end(JSON.stringify(result));
}

// ========== Module exports ==========
export {
  GengaWorldApiClient,
  GengaWorldMovieApi,
  GengaWorldUserApi,
  GengaWorldRecommendationApi,
  handleGengaWorldApi,
};

// Default export for easy import
export default {
  GengaWorldApiClient,
  GengaWorldMovieApi,
  GengaWorldUserApi,
  GengaWorldRecommendationApi,
  handleGengaWorldApi,
};
