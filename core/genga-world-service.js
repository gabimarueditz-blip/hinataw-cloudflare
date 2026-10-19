// Genga-World Service Layer
// Enhanced service with additional features for Render deployment
// Target: core/genga-world-service.js

import {
  GengaWorldApiClient,
  GengaWorldMovieApi,
  GengaWorldUserApi,
  GengaWorldRecommendationApi,
} from "./genga-world-api.js";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, ".cache");

// ========== GengaWorld Enhanced Service ==========
class GengaWorldService {
  constructor(config = {}) {
    this.config = {
      baseUrl: config.baseUrl || process.env.GW_API_BASE_URL || "https://api.gengaworld.example.com",
      apiVersion: config.apiVersion || "v1",
      timeout: config.timeout || 30000,
      cacheEnabled: config.cacheEnabled !== false && process.env.CACHE_ENABLED !== "false",
      cacheTTL: config.cacheTTL || 300000, // 5 minutes default
      ...config,
    };

    // Initialize API client
    this.apiClient = new GengaWorldApiClient({
      baseUrl: this.config.baseUrl,
      apiVersion: this.config.apiVersion,
      timeout: this.config.timeout,
      cacheEnabled: this.config.cacheEnabled,
      userAgent: "GengaWorld-Service/1.0 (Render)",
    });

    // Initialize API services
    this.movieApi = new GengaWorldMovieApi(this.apiClient);
    this.userApi = new GengaWorldUserApi(this.apiClient);
    this.recApi = new GengaWorldRecommendationApi(this.apiClient);
  }

  /**
   * Initialize service with configuration
   */
  async init() {
    // Warm up cache with essential data
    await this.warmCache();
    return this;
  }

  /**
   * Warm up cache with common data
   */
  async warmCache() {
    console.log("[GengaWorldService] Warming cache...");
    try {
      await Promise.all([
        this.movieApi.getTrending(10),
        this.movieApi.getLatest(10),
        this.movieApi.getMovieList(1, 10),
      ]);
      console.log("[GengaWorldService] Cache warmed successfully");
    } catch (error) {
      console.warn("[GengaWorldService] Cache warmup failed:", error.message);
    }
  }

  /**
   * Get home page data (combined catalog)
   */
  async getHomeData() {
    const [movieList, trending, latest, categories] = await Promise.all([
      this.movieApi.getMovieList(1, 20),
      this.movieApi.getTrending(20),
      this.movieApi.getLatest(20),
      this.recApi.getCategories(),
    ]);

    return {
      movies: movieList.data?.movies || movieList.data || [],
      trending: trending.data?.movies || trending.data || [],
      latest: latest.data?.movies || latest.data || [],
      categories: categories.data?.categories || categories.data || [],
    };
  }

  /**
   * Get movie by ID with full details
   */
  async getMovieDetail(movieId) {
    const [movie, streams, related] = await Promise.all([
      this.movieApi.getMovieById(movieId),
      this.movieApi.getMovieStreams(movieId, "1080"),
      this.recApi.getRelated(movieId, 10),
    ]);

    return {
      movie: movie.data?.movie || movie.data || {},
      streams: streams.data?.streams || streams.data || [],
      related: related.data?.movies || related.data || [],
    };
  }

  /**
   * Search movies
   */
  async search(query, options = {}) {
    const { page = 1, limit = 20 } = options;
    const results = await this.movieApi.searchMovies(query, page, limit);
    return {
      results: results.data?.results || results.data || [],
      total: results.data?.total || 0,
      query,
    };
  }

  /**
   * Get movies by category
   */
  async getCategoryMovies(categoryId, options = {}) {
    const { page = 1, limit = 20 } = options;
    const movies = await this.movieApi.getMovieList(page, limit, categoryId);
    return {
      category: { id: categoryId },
      movies: movies.data?.movies || movies.data || [],
    };
  }

  /**
   * Get user watchlist
   */
  async getWatchlist(options = {}) {
    const { page = 1, limit = 20 } = options;
    const watchlist = await this.userApi.getWatchlist(page, limit);
    return {
      watchlist: watchlist.data?.watchlist || watchlist.data || [],
    };
  }

  /**
   * Add to watchlist
   */
  async addToWatchlist(movieId) {
    return this.userApi.addToWatchlist(movieId);
  }

  /**
   * Remove from watchlist
   */
  async removeFromWatchlist(movieId) {
    return this.userApi.removeFromWatchlist(movieId);
  }

  /**
   * Get personalized recommendations
   */
  async getRecommendations(userId, options = {}) {
    const { limit = 20 } = options;
    const recommendations = await this.recApi.getRecommendations(userId, limit);
    return {
      recommendations: recommendations.data?.movies || recommendations.data || [],
      userId,
    };
  }

  /**
   * Get all categories
   */
  async getCategories() {
    const categories = await this.recApi.getCategories();
    return categories.data?.categories || categories.data || [];
  }

  /**
   * Get trending movies
   */
  async getTrending(options = {}) {
    const { limit = 20 } = options;
    const trending = await this.movieApi.getTrending(limit);
    return { movies: trending.data?.movies || trending.data || [] };
  }

  /**
   * Get latest movies
   */
  async getLatest(options = {}) {
    const { limit = 20 } = options;
    const latest = await this.movieApi.getLatest(limit);
    return { movies: latest.data?.movies || latest.data || [] };
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      // Quick test with trending movies
      await this.movieApi.getTrending(1);
      return { status: "ok", timestamp: Date.now() };
    } catch (error) {
      return { status: "error", message: error.message };
    }
  }

  /**
   * Clear cache for a specific key
   */
  clearCache(key) {
    const cachePath = resolve(CACHE_DIR, `${key}.json`);
    if (existsSync(cachePath)) {
      try {
        // Using node:fs unlink sync for simplicity
        const { unlinkSync } = await import("node:fs");
        unlinkSync(cachePath);
      } catch (error) {
        console.warn(`[GengaWorldService] Failed to clear cache for ${key}:`, error.message);
      }
    }
  }

  /**
   * Clear all cache
   */
  clearAllCache() {
    try {
      const { readdirSync, unlinkSync } = require("node:fs");
      const files = readdirSync(CACHE_DIR);
      for (const file of files) {
        if (file.endsWith(".json")) {
          unlinkSync(resolve(CACHE_DIR, file));
        }
      }
      console.log("[GengaWorldService] All cache cleared");
    } catch (error) {
      console.warn("[GengaWorldService] Failed to clear cache:", error.message);
    }
  }
}

// ========== Singleton instance ==========
let serviceInstance = null;

export function getGengaWorldService(config = {}) {
  if (!serviceInstance) {
    serviceInstance = new GengaWorldService(config);
  }
  return serviceInstance;
}

export function resetGengaWorldService() {
  serviceInstance = null;
}

// Export all classes for advanced usage
export {
  GengaWorldApiClient,
  GengaWorldMovieApi,
  GengaWorldUserApi,
  GengaWorldRecommendationApi,
};

// Default export
export default GengaWorldService;
