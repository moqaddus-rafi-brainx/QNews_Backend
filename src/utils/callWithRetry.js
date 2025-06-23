// utils/callWithRetry.js

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enhanced retry function that handles various rate limiting scenarios
 * @param {Function} fn - Async function to call (e.g., OpenAI request)
 * @param {number} maxRetries - Maximum retries on rate limit
 * @param {number} baseDelay - Base delay in ms between retries
 * @returns {Promise<any>}
 */
async function callWithRetry(fn, maxRetries = 5, baseDelay = 500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(); // Attempt the API call
    } catch (error) {
      // Check for various rate limiting scenarios
      const isRateLimit = 
        error?.code === 'rate_limit_exceeded' || 
        error?.response?.status === 429 ||
        error?.message?.includes('rate limit') ||
        error?.message?.includes('too many requests') ||
        error?.message?.includes('token per minute') ||
        error?.message?.includes('quota exceeded') ||
        error?.message?.includes('rate limit') ||
        error?.status === 429 ||
        error?.statusCode === 429;

      // Check for quota exceeded errors
      const isQuotaExceeded = 
        error?.code === 'quota_exceeded' ||
        error?.message?.includes('quota') ||
        error?.message?.includes('billing') ||
        error?.message?.includes('credit');

      // Check for server errors that might be temporary
      const isServerError = 
        error?.response?.status >= 500 ||
        error?.status >= 500 ||
        error?.statusCode >= 500;

      // Determine if error is retryable
      const isRetryable = isRateLimit || isQuotaExceeded || isServerError;

      if (!isRetryable || attempt === maxRetries) {
        console.error(`❌ Final attempt failed (${attempt}/${maxRetries}):`, error.message);
        throw error; // Rethrow if not retryable or retries exhausted
      }

      // Calculate exponential backoff with jitter
      const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
      const wait = Math.min(exponentialDelay + jitter, 30000); // Cap at 30 seconds instead of 60

      console.warn(`🔁 Rate limit/quota hit (attempt ${attempt}/${maxRetries}). Retrying in ${(wait/1000).toFixed(1)}s`);
      console.warn(`Error details: ${error.message}`);
      
      await sleep(wait);
    }
  }
}

/**
 * Batch processor with rate limiting for multiple async operations
 * @param {Array} items - Array of items to process
 * @param {Function} processor - Async function to process each item
 * @param {number} batchSize - Number of items to process in parallel
 * @param {number} delayBetweenBatches - Delay in ms between batches
 * @returns {Promise<Array>} Array of results
 */
async function processBatchWithRateLimit(items, processor, batchSize = 2, delayBetweenBatches = 2000) {
  const results = [];
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    console.log(`📦 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(items.length/batchSize)} (${batch.length} items)`);
    
    try {
      const batchResults = await Promise.all(
        batch.map((item, index) => 
          callWithRetry(() => processor(item, i + index), 5, 1000)
        )
      );
      
      results.push(...batchResults);
      
      // Add delay between batches to avoid rate limits
      if (i + batchSize < items.length) {
        console.log(`⏳ Waiting ${delayBetweenBatches/1000}s before next batch...`);
        await sleep(delayBetweenBatches);
      }
    } catch (error) {
      console.error(`❌ Batch processing failed:`, error.message);
      throw error;
    }
  }
  
  return results;
}

module.exports = { callWithRetry, processBatchWithRateLimit };
