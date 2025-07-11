const { generateSignedUrl } = require('../services/googleStorageService');

/**
 * Generate signed URL for file upload
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function getSignedUrl(req, res) {
  try {
    console.log(req.body);
    const { fileName, fileType, fileSize } = req.body;

    // Validate required fields
    if (!fileName || !fileType || !fileSize) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: fileName, fileType, fileSize'
      });
    }

    // Validate file type (only allow video files)
    const allowedVideoTypes = [
      'video/mp4',
      'video/avi',
      'video/mov',
      'video/wmv',
      'video/flv',
      'video/webm',
      'video/mkv',
      'video/m4v',
      'video/3gp',
      'video/ogv'
    ];

    if (!allowedVideoTypes.includes(fileType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid file type. Only video files are allowed.'
      });
    }

    // Validate file size (max 500MB)
    const maxFileSize = 500 * 1024 * 1024; // 500MB in bytes
    if (fileSize > maxFileSize) {
      return res.status(400).json({
        success: false,
        error: 'File size too large. Maximum allowed size is 500MB.'
      });
    }

    // Generate signed URL
    const result = await generateSignedUrl(fileName, fileType, fileSize);
    console.log(result);
    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Failed to generate signed URL'
      });
    }

    // Return success response
    res.json({
      success: true,
      data: {
        signedUrl: result.signedUrl,
        filePath: result.filePath,
        publicUrl: result.publicUrl,
        fileName: result.fileName,
        bucketName: result.bucketName,
        expiresIn: '15 minutes'
      }
    });

  } catch (error) {
    console.error('Error in getSignedUrl controller:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error while generating signed URL'
    });
  }
}

module.exports = {
  getSignedUrl
}; 