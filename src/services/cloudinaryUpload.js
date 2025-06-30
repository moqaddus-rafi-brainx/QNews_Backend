// services/cloudinaryUpload.js
const cloudinary = require('../config/cloudinary');

/**
 * Uploads a video buffer to Cloudinary and returns the public URL
 * @param {Buffer} buffer - The video file buffer
 * @param {string} folder - Optional folder name in Cloudinary
 * @returns {Promise<string>} - The uploaded video URL
 */
function uploadVideoToCloudinary(buffer, folder = 'my_videos') {
  console.log("uploading video to cloudinary");
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        resource_type: 'video',
        folder,
        timeout: 300000
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    ).end(buffer);
  });
}

/**
 * Uploads an audio buffer to Cloudinary and returns the public URL
 * @param {Buffer} buffer - The audio file buffer
 * @param {string} folder - Optional folder name in Cloudinary
 * @returns {Promise<string>} - The uploaded audio URL
 */
function uploadAudioToCloudinary(buffer, folder = 'my_audio') {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        resource_type: 'video', // Cloudinary uses 'video' for audio files
        folder,
        format: 'mp3', // Specify the audio format
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    ).end(buffer);
  });
}

module.exports = {
  uploadVideoToCloudinary,
  uploadAudioToCloudinary
};
