const { Storage } = require('@google-cloud/storage');
const path = require('path');
const crypto = require('crypto');

// Initialize Google Cloud Storage
const storage = new Storage({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  },
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID
});

const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'qnews-dev';

/**
 * Generate a unique filename for upload
 * @param {string} originalFileName - Original file name
 * @param {string} fileType - File MIME type
 * @returns {string} Unique filename
 */
function generateUniqueFileName(originalFileName, fileType) {
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString('hex');
  const fileExtension = path.extname(originalFileName) || getExtensionFromMimeType(fileType);
  
  return `video_${timestamp}_${randomString}${fileExtension}`;
}

/**
 * Get file extension from MIME type
 * @param {string} mimeType - MIME type
 * @returns {string} File extension
 */
function getExtensionFromMimeType(mimeType) {
  const mimeToExt = {
    'video/mp4': '.mp4',
    'video/avi': '.avi',
    'video/mov': '.mov',
    'video/wmv': '.wmv',
    'video/flv': '.flv',
    'video/webm': '.webm',
    'video/mkv': '.mkv',
    'video/m4v': '.m4v',
    'video/3gp': '.3gp',
    'video/ogv': '.ogv'
  };
  
  return mimeToExt[mimeType] || '.mp4';
}

/**
 * Generate signed URL for file upload
 * @param {string} fileName - File name
 * @param {string} fileType - File MIME type
 * @param {number} fileSize - File size in bytes
 * @returns {Promise<Object>} Object containing signed URL, file path, and public URL
 */
async function generateSignedUrl(fileName, fileType, fileSize) {
  try {
    // Generate unique filename
    const uniqueFileName = generateUniqueFileName(fileName, fileType);
    
    // Create file path in bucket
    const filePath = `uploads/${uniqueFileName}`;
    
    // Get bucket
    const bucket = storage.bucket(bucketName);
   
    
    // Create file object
    const file = bucket.file(filePath);
    
    // Generate signed URL for upload
    const [signedUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
     
      
    });
    
    // Generate public URL (after upload)
    const publicUrl = `https://storage.googleapis.com/${bucketName}/${filePath}`;
    
    return {
      success: true,
      signedUrl,
      filePath,
      publicUrl,
      fileName: uniqueFileName,
      bucketName
    };
    
  } catch (error) {
    console.error('Error generating signed URL:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Generate signed URL for file reading/viewing
 * @param {string} filePath - File path in bucket
 * @param {number} expirationMinutes - URL expiration time in minutes (default: 60)
 * @returns {Promise<Object>} Object containing signed URL for reading
 */
async function generateReadSignedUrl(filePath, expirationMinutes = 60) {
  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filePath);
    
    // Check if file exists
    const [exists] = await file.exists();
    if (!exists) {
      return {
        success: false,
        error: 'File not found'
      };
    }
    
    // Generate signed URL for reading
    const [signedUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + (expirationMinutes * 60 * 1000), // Convert minutes to milliseconds
      responseType: 'application/octet-stream'
    });
    
    return {
      success: true,
      signedUrl,
      filePath,
      expirationMinutes
    };
    
  } catch (error) {
    console.error('Error generating read signed URL:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Upload video buffer to Google Cloud Storage and return read signed URL
 * @param {Buffer} videoBuffer - Video file buffer
 * @param {string} originalFileName - Original file name
 * @param {string} fileType - File MIME type
 * @param {number} expirationMinutes - URL expiration time in minutes (default: 60)
 * @returns {Promise<Object>} Object containing signed URL, file path, and upload details
 */
async function uploadVideoBufferAndGetSignedUrl(videoBuffer, originalFileName, fileType, expirationMinutes = 60) {
  try {
    // Generate unique filename
    const uniqueFileName = generateUniqueFileName(originalFileName, fileType);
    
    // Create file path in bucket
    const filePath = `uploads/${uniqueFileName}`;
    
    // Get bucket
    const bucket = storage.bucket(bucketName);
    
    // Create file object
    const file = bucket.file(filePath);
    
    // Upload the buffer to Google Cloud Storage
    await file.save(videoBuffer, {
      metadata: {
        contentType: fileType,
        cacheControl: 'public, max-age=31536000' // 1 year cache
      },
      resumable: false // For smaller files, use non-resumable upload
    });
    
    console.log(`Video uploaded successfully to ${filePath}`);
    
    // Generate signed URL for reading
    const [signedUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + (expirationMinutes * 60 * 1000), // Convert minutes to milliseconds
      responseType: 'application/octet-stream'
    });
    
    // Generate public URL (for reference)
    const publicUrl = `https://storage.googleapis.com/${bucketName}/${filePath}`;
    
    return {
      success: true,
      signedUrl,
      filePath,
      publicUrl,
      fileName: uniqueFileName,
      bucketName,
      fileSize: videoBuffer.length,
      contentType: fileType,
      expirationMinutes
    };
    
  } catch (error) {
    console.error('Error uploading video buffer:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Upload audio buffer to Google Cloud Storage and return read signed URL
 * @param {Buffer} audioBuffer - Audio file buffer
 * @param {string} originalFileName - Original file name
 * @param {string} fileType - File MIME type (e.g., 'audio/mp3', 'audio/wav')
 * @param {number} expirationMinutes - URL expiration time in minutes (default: 60)
 * @returns {Promise<Object>} Object containing signed URL, file path, and upload details
 */
async function uploadAudioBufferAndGetSignedUrl(audioBuffer, originalFileName, fileType, expirationMinutes = 60) {
  try {
    // Generate unique filename for audio
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString('hex');
    const fileExtension = path.extname(originalFileName) || getAudioExtensionFromMimeType(fileType);
    
    const uniqueFileName = `audio_${timestamp}_${randomString}${fileExtension}`;
    
    // Create file path in bucket
    const filePath = `voiceovers/${uniqueFileName}`;
    
    // Get bucket
    const bucket = storage.bucket(bucketName);
    
    // Create file object
    const file = bucket.file(filePath);
    
    // Upload the buffer to Google Cloud Storage
    await file.save(audioBuffer, {
      metadata: {
        contentType: fileType,
        cacheControl: 'public, max-age=31536000' // 1 year cache
      },
      resumable: false // For smaller files, use non-resumable upload
    });
    
    console.log(`Audio uploaded successfully to ${filePath}`);
    
    // Generate signed URL for reading
    const [signedUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + (expirationMinutes * 60 * 1000), // Convert minutes to milliseconds
      responseType: 'application/octet-stream'
    });
    
    // Generate public URL (for reference)
    const publicUrl = `https://storage.googleapis.com/${bucketName}/${filePath}`;
    
    return {
      success: true,
      signedUrl,
      filePath,
      publicUrl,
      fileName: uniqueFileName,
      bucketName,
      fileSize: audioBuffer.length,
      contentType: fileType,
      expirationMinutes
    };
    
  } catch (error) {
    console.error('Error uploading audio buffer:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get audio file extension from MIME type
 * @param {string} mimeType - MIME type
 * @returns {string} File extension
 */
function getAudioExtensionFromMimeType(mimeType) {
  const mimeToExt = {
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/webm': '.webm',
    'audio/aac': '.aac',
    'audio/flac': '.flac',
    'audio/m4a': '.m4a',
    'audio/wma': '.wma',
    'audio/opus': '.opus'
  };
  
  return mimeToExt[mimeType] || '.mp3';
}

/**
 * Get public URL for an uploaded file
 * @param {string} filePath - File path in bucket
 * @returns {string} Public URL
 */
function getPublicUrl(filePath) {
  return `https://storage.googleapis.com/${bucketName}/${filePath}`;
}

/**
 * Delete file from Google Cloud Storage
 * @param {string} filePath - File path in bucket
 * @returns {Promise<boolean>} Success status
 */
async function deleteFile(filePath) {
  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filePath);
    
    await file.delete();
    console.log(`File ${filePath} deleted successfully`);
    return true;
  } catch (error) {
    console.error(`Error deleting file ${filePath}:`, error);
    return false;
  }
}

/**
 * Check if file exists in bucket
 * @param {string} filePath - File path in bucket
 * @returns {Promise<boolean>} File existence status
 */
async function fileExists(filePath) {
  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filePath);
    
    const [exists] = await file.exists();
    return exists;
  } catch (error) {
    console.error(`Error checking file existence ${filePath}:`, error);
    return false;
  }
}

module.exports = {
  generateSignedUrl,
  generateReadSignedUrl,
  uploadVideoBufferAndGetSignedUrl,
  uploadAudioBufferAndGetSignedUrl,
  getPublicUrl,
  deleteFile,
  fileExists,
  generateUniqueFileName
}; 