// Genga-World API Handler
// Integrates with server.js to handle /api/gengaworld/* routes
// Target: api/gengaworld-handler.js

import { handleGengaWorldApi, initGengaWorldService } from "./gengaworld.js";

// Export the handler for use in server.js
export { handleGengaWorldApi, initGengaWorldService };

// Export individual route handlers if needed
export {
  // Router
  handleGengaWorldApi,
  // Service initialization
  initGengaWorldService,
  // Individual handlers (re-exported from gengaworld.js)
  // These are primarily for testing/advanced usage
};
