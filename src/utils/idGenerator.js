/**
 * Utility functions for generating unique IDs
 */

/**
 * Generate a unique session ID using timestamp and random string
 * @returns {string} A unique session ID
 */
function generateSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

/**
 * Generate a unique task ID for downloads
 * @param {string} playlistId - The playlist ID
 * @param {string|number} trackId - The track ID or timestamp
 * @returns {string} A unique task ID
 */
function generateTaskId(playlistId, trackId) {
  const id = trackId || Date.now();
  return `${playlistId}-${id}-${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = {
  generateSessionId,
  generateTaskId
};
