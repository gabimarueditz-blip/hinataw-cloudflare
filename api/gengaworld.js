// Genga-World API Router
// Integrated into Render project at /api/gengaworld/*
// Target: api/gengaworld.js

import { getGengaWorldService, resetGengaWorldService } from "../core/genga-world-service.js";

// Response helpers
function jsonResponse(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60");
  res.end(JSON.stringify(data));
}

function errorResponse(res, statusCode, error) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({
    success: false,
    error: error?.message || error || "Internal server error",
  }));
}

// Get or create GengaWorld service instance
function getService() {
  if (!getService._instance) {
    getService._instance = getGengaWorldService();
  }
  return getService._instance;
}

// Health check endpoint
async function handleHealthCheck(req, res) {
  try {
    const service = getService();
    const health = await service.healthCheck();
    jsonResponse(res, 200, health);
  } catch (error) {
    errorResponse(res, 500, error);
  }
}

// Home / catalog endpoint
async function handleHome(req, res) {
  try {
    const service = getService();
    const data = await service.getHomeData();
    jsonResponse(res, 200, {
      success: true,
      data,
    });
  } catch (error) {
    errorResponse(res, 500, error);
  }
}

// Movie detail endpoint
async function handleMovieDetail(req, res, url) {
  try {
    const service = getService();
    const movieId = url.searchParams.get("id") || url.searchParams.get("movieId");

    if (!movieId) {
      return errorResponse(res, 400, { success: false, error: "Movie ID required" });
    }

    const data = await service.getMovieDetail(movieId);
    jsonResponse(res, 200, {
      success: true,
      data,
    });
  } catch (error) {
    errorResponse(res, 500, error);
  }
}

// Search endpoint
async function handleSearch(req, res, url) {
  try {
    const service = getService();
    const query = url.searchParams.get("q") || url.searchParams.get("query");

    if (!query) {
      return errorResponse(res, 400, { success: false, error: "Search query required" });
    }

    const page = parseInt(url.searchParams.get("page") || "1");
    const limit = parseInt(url.searchParams.get("limit") || "20");

    const data = await service.search(query, { page, limit });
    jsonResponse(res, 200, {
      success: true,
      data,
    });
  } catch (error) {
    errorResponse(res, 500, error);
  }
}

// Categories endpoint
async function handleCategories(req, res) {
  try {
    const service = getService();
    const data = await service.getCategories();
    jsonResponse(res, 200, {
      success: true,
      data,
    });
  } catch (error) {
    errorResponse(res, 500, error);
  }
}

// Category movies endpoint
async function handleCategoryMovies(req, res, url) {
  try {
    const service = getService();
    const categoryId = url.searchParams.get("category") || url.searchParams.get("id");

    if (!categoryId) {
      return errorResponse(res, 400, { success: false, error: "Category ID required" });
    }

    const page = parseInt(url.searchParams.get("page") || "1");
    const limit = parseInt(url.searchParams.get("limit") || "20");

    const data = await service.getCategoryMovies(categoryId, { page, limit });
    jsonResponse(res, 200, {
      success: true,
      data,
    });
  } catch (error) {
    errorResponse(res, 500, error);
  }
}

// Watchlist endpoints
async function handleWatchlist(req, res, url) {
  const method = req.method.toUpperCase();

  try {
    const service = getService();

    if (method === "GET") {
      // Get watchlist
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "20");
      const data = await service.getWatchlist({ page, limit });
      jsonResponse(res, 200, {
        success: true,
        data,
      });
    } else if (method === "POST") {
      // Add to watchlist
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      const { movieId } = JSON.parse(body || "{}");

      if (!movieId) {
        return errorResponse(res, 400, { success: false, error: "Movie ID required" });
      }

      const result = await service.addToWatchlist(movieId);
      jsonResponse(res, 200, {
        success: true,
        data: result,
      });
    } else {
      errorResponse(res, 405, { success: false, error: "Method not allowed" });
    }
  } catch (error) {
    errorResponse(res, 500, error);
  }
}

// Remove from watchlist
async function handleRemoveWatchlist(req, res, url) {
  try {
    const service = getService();
    const movieId = url.searchParams.get("movieId") || url.searchParams.get("id");

    if (!movieId) {
      return errorResponse(res, 400, { success: false, error: "Movie ID required" });
    }

    const result = await service.removeFromWatchlist(movieId);
    jsonResponse(res, 200, {
      success: true,
      data: result,
    });
  } catch (error) {
    errorResponse(res, 500, error);
  }
}

// Recommendations endpoint
async function handleRecommendations(req, res, url) {
  try {
    const service = getService();
    const userId = url.searchParams.get("userId") || url.searchParams.get("user") || "default";
    const limit = parseInt(url.searchParams.get("limit") || "20");

    const data = await service.getRecommendations(userId, { limit });
    jsonResponse(res, 200, {
      success: true,
      data,
    });
  } catch (error) {
    errorResponse(res, 500, error);
  }
}

// Trending endpoint
async function handleTrending(req, res, url) {
  try {
    const service = getService();
    const limit = parseInt(url.searchParams.get("limit") || "20");
    const data = await service.getTrending({ limit });
    jsonResponse(res, 200, {
      success: true,
      data,
    });
  } catch (error) {
    errorResponse(res, 500, error);
  }
}

// Latest endpoint
async function handleLatest(req, res, url) {
  try {
    const service = getService();
    const limit = parseInt(url.searchParams.get("limit") || "20");
    const data = await service.getLatest({ limit });
    jsonResponse(res, 200, {
      success: true,
      data,
    });
  } catch (error) {
    errorResponse(res, 500, error);
  }
}

// Clear cache endpoint (admin only - simplified)
async function handleClearCache(req, res) {
  try {
    const service = getService();
    service.clearAllCache();
    jsonResponse(res, 200, {
      success: true,
      message: "Cache cleared",
    });
  } catch (error) {
    errorResponse(res, 500, error);
  }
}

// Main router
export async function handleGengaWorldApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // Parse path segments
  const segments = pathname.split("/").filter(Boolean);

  // Remove /api/gengaworld prefix if present
  if (segments[0] === "api" && segments[1] === "gengaworld") {
    segments.splice(0, 2);
  }

  console.log(`[GengaWorldApi] ${method} ${pathname}`);

  try {
    // Route matching
    if (segments.length === 0 || segments[0] === "home" || segments[0] === "index" || segments[0] === "") {
      await handleHome(req, res);
    } else if (segments[0] === "health" || segments[0] === "ping") {
      await handleHealthCheck(req, res);
    } else if (segments[0] === "movie" && (segments[1] === "detail" || segments.length === 2)) {
      await handleMovieDetail(req, res, url);
    } else if (segments[0] === "search") {
      await handleSearch(req, res, url);
    } else if (segments[0] === "categories" || (segments[0] === "category" && !segments[1])) {
      await handleCategories(req, res);
    } else if (segments[0] === "category" && segments[1]) {
      await handleCategoryMovies(req, res, url);
    } else if (segments[0] === "user" && segments[1] === "watchlist") {
      await handleWatchlist(req, res, url);
    } else if (segments[0] === "watchlist" && method === "DELETE") {
      await handleRemoveWatchlist(req, res, url);
    } else if (segments[0] === "recommendations" || segments[0] === "recommend") {
      await handleRecommendations(req, res, url);
    } else if (segments[0] === "trending") {
      await handleTrending(req, res, url);
    } else if (segments[0] === "latest" || segments[0] === "new") {
      await handleLatest(req, res, url);
    } else if (pathname === "/api/gengaworld/cache/clear" || pathname === "/api/gengaworld/clear-cache") {
      await handleClearCache(req, res);
    } else {
      errorResponse(res, 404, { success: false, error: `Unknown GengaWorld endpoint: ${pathname}` });
    }
  } catch (error) {
    console.error(`[GengaWorldApi] Router error: ${error.message}`);
    if (!res.headersSent) {
      errorResponse(res, 500, error);
    }
  }
}

// Initialize service on first request
export async function initGengaWorldService() {
  try {
    const service = getService();
    await service.init();
    console.log("[GengaWorldApi] Service initialized");
  } catch (error) {
    console.warn("[GengaWorldApi] Service init failed:", error.message);
  }
}

// Export all handlers for advanced usage
export {
  handleHealthCheck,
  handleHome,
  handleMovieDetail,
  handleSearch,
  handleCategories,
  handleCategoryMovies,
  handleWatchlist,
  handleRemoveWatchlist,
  handleRecommendations,
  handleTrending,
  handleLatest,
  handleClearCache,
  initGengaWorldService,
  getService,
  resetGengaWorldService,
};
