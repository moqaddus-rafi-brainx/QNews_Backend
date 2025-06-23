// utils/callWithRetry.js

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps any async call with retry-on-rate-limit logic
 * @param {Function} fn - Async function to call (e.g., OpenAI request)
 * @param {number} maxRetries - Maximum retries on rate limit
 * @param {number} retryDelayBase - Delay in ms between retries (base delay)
 * @returns {Promise<any>}
 */
async function callWithRetry(fn, maxRetries = 3, retryDelayBase = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(); // Attempt the API call
    } catch (error) {
      const isRateLimit = error?.code === 'rate_limit_exceeded' || error?.response?.status === 429;

      if (!isRateLimit || attempt === maxRetries) {
        throw error; // Rethrow if not retryable or retries exhausted
      }

      const wait = retryDelayBase * attempt;
      console.warn(`🔁 Rate limit hit. Retrying in ${wait / 1000}s (attempt ${attempt}/${maxRetries})`);
      await sleep(wait);
    }
  }
}

module.exports = callWithRetry;
