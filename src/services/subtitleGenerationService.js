const { OpenAI } = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Import Cloudinary upload function
const { uploadVideoToCloudinary } = require('./cloudinaryUpload');

/**
 * Downloads a video from URL and saves it temporarily
 * @param {string} videoUrl - URL of the video to download
 * @returns {Promise<string>} Path to the temporary video file
 */
async function downloadVideoFromUrl(videoUrl) {
  try {
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'arraybuffer',
      timeout: 30000 // 30 seconds timeout
    });

    const tempVideoPath = path.join('/tmp', `temp_video_${Date.now()}.mp4`);
    await fs.writeFile(tempVideoPath, response.data);
    
    return tempVideoPath;
  } catch (error) {
    console.error('Error downloading video:', error);
    throw new Error(`Failed to download video from URL: ${error.message}`);
  }
}

/**
 * Generates SRT file content from subtitle chunks
 * @param {Array} subtitleChunks - Array of objects: {transcript, startTime, endTime}
 * @returns {Promise<string>} SRT file content as a string
 */
async function generateSRTFromChunks(subtitleChunks) {
  if (!Array.isArray(subtitleChunks) || subtitleChunks.length === 0) return '';

  // Helper to convert seconds to SRT time format
  function secondsToSRTTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const milliseconds = Math.floor((seconds % 1) * 1000);
    return `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${secs.toString().padStart(2, '0')},${milliseconds
      .toString()
      .padStart(3, '0')}`;
  }

  // Translate each chunk to English
  const translatedChunks = [];
  for (let i = 0; i < subtitleChunks.length; i++) {
    const chunk = subtitleChunks[i];
    console.log(`Translating chunk ${i + 1}/${subtitleChunks.length}...`);
    
    try {
      const translatedText = await translateTranscriptToEnglish(chunk.transcript);
      translatedChunks.push({
        ...chunk,
        transcript: translatedText
      });
    } catch (error) {
      console.error(`Failed to translate chunk ${i + 1}:`, error);
      // Use original text if translation fails
      translatedChunks.push(chunk);
    }
  }

  return translatedChunks
    .map((chunk, idx) => {
      const start = secondsToSRTTime(chunk.startTime);
      const end = secondsToSRTTime(chunk.endTime);
      const text = chunk.transcript.trim();
      return `${idx + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join('\n');
}

async function processVideoWithChunkedSubtitles(videoUrl, subtitleChunks, srtFilename = 'temp_subtitles.srt', targetLanguage = 'en', translateToEnglish = true, sourceLanguage = 'auto') {
  let tempVideoPath = null;
  let srtFilePath = null;
  let outputVideoPath = null;
  const tempFiles = [];

  try {
    
    // Step 1: Download video from URL
    console.log('Downloading video from URL...');
    tempVideoPath = await downloadVideoFromUrl(videoUrl);
    tempFiles.push(tempVideoPath);
    console.log('Video downloaded successfully');


    // Step 2: Generate SRT subtitles
    console.log('Generating SRT subtitles...');
    const srtContent = await generateSRTFromChunks(subtitleChunks);
    srtFilePath = await saveSRTToFile(srtContent, srtFilename);
    tempFiles.push(srtFilePath);
    console.log('SRT subtitles generated successfully');

    // Step 3: Apply subtitles to video using FFmpeg
    console.log('Applying subtitles to video...');
    outputVideoPath = await applySubtitlesToVideo(tempVideoPath, srtFilePath);
    tempFiles.push(outputVideoPath);
    console.log('Subtitles applied successfully');

    // Step 4: Upload video to Cloudinary
    console.log('Uploading video to Cloudinary...');
    const videoBuffer = await fs.readFile(outputVideoPath);
    const cloudinaryUrl = await uploadVideoToCloudinary(videoBuffer);
    console.log('Video uploaded to Cloudinary successfully');
    console.log('cloudinaryUrl:', cloudinaryUrl);

    // Step 5: Clean up temporary files
    console.log('Cleaning up temporary files...');
    await cleanupTempFiles(tempFiles);

    return {
      success: true,
      cloudinaryUrl,
      processingDetails: {
        originalVideoUrl: videoUrl,
        targetLanguage,
        translationApplied: translateToEnglish,
        sourceLanguage: translateToEnglish ? sourceLanguage : 'none',
        processingSteps: [
          'Video downloaded from URL',
          ...(translateToEnglish ? ['Transcripts translated to English'] : []),
          'SRT subtitles generated',
          'Subtitles applied using FFmpeg',
          'Video uploaded to Cloudinary',
          'Temporary files cleaned up'
        ]
      }
    };

  } catch (error) {
    console.error('Error in video processing with subtitles:', error);
    
    // Clean up any temporary files that were created
    if (tempFiles.length > 0) {
      console.log('Cleaning up temporary files due to error...');
      await cleanupTempFiles(tempFiles);
    }

    return {
      success: false,
      error: error.message,
      processingDetails: {
        originalVideoUrl: videoUrl,
        targetLanguage,
        translationApplied: translateToEnglish,
        sourceLanguage: translateToEnglish ? sourceLanguage : 'none',
        errorStep: error.message
      }
    };
  }
}



/**
 * Applies SRT subtitles to a video using FFmpeg
 * @param {string} inputVideoPath - Path to input video file
 * @param {string} srtFilePath - Path to SRT subtitle file
 * @returns {Promise<string>} Path to the output video with subtitles
 */
function applySubtitlesToVideo(inputVideoPath, srtFilePath) {
  return new Promise((resolve, reject) => {
    const outputVideoPath = path.join('/tmp', `video_with_subs_${Date.now()}.mp4`);
    
    console.log('FFmpeg input path:', inputVideoPath);
    console.log('SRT file path:', srtFilePath);
    console.log('Output path:', outputVideoPath);
    
    // Check if input files exist
    const fs = require('fs');
    if (!fs.existsSync(inputVideoPath)) {
      reject(new Error(`Input video file does not exist: ${inputVideoPath}`));
      return;
    }
    if (!fs.existsSync(srtFilePath)) {
      reject(new Error(`SRT file does not exist: ${srtFilePath}`));
      return;
    }
    
    // Read and log SRT content for debugging
    try {
      const srtContent = fs.readFileSync(srtFilePath, 'utf8');
      console.log('SRT content preview:', srtContent.substring(0, 200) + '...');
    } catch (error) {
      console.warn('Could not read SRT file for debugging:', error.message);
    }
    
    ffmpeg(inputVideoPath)
      .videoFilters(`subtitles=${srtFilePath}`) // Remove quotes around file path
      .outputOptions([
        '-c:v libx264',
        '-c:a aac',
        '-preset fast',
        '-crf 23'
      ])
      .on('start', (commandLine) => {
        console.log('FFmpeg command:', commandLine);
      })
      .on('progress', (progress) => {
        console.log('FFmpeg progress:', progress.percent + '%');
      })
      .on('end', () => {
        console.log('FFmpeg processing completed successfully');
        resolve(outputVideoPath);
      })
      .on('error', (err) => {
        console.error('Error applying subtitles:', err);
        console.error('FFmpeg stderr:', err.stderr);
        reject(new Error(`Failed to apply subtitles: ${err.message}`));
      })
      .save(outputVideoPath);
  });
}

/**
 * Cleans up temporary files
 * @param {Array} filePaths - Array of file paths to delete
 */
async function cleanupTempFiles(filePaths) {
  for (const filePath of filePaths) {
    try {
      await fs.unlink(filePath);
      console.log(`Cleaned up temporary file: ${filePath}`);
    } catch (error) {
      console.warn(`Warning: Could not delete temporary file ${filePath}:`, error.message);
    }
  }
}

/**
 * Downloads video from URL, applies subtitles, uploads to Cloudinary, and cleans up
 * @param {string} videoUrl - URL of the video to process
 * @param {Array} relevantContent - Array of objects with nested transcripts for subtitle generation
 * @param {string} srtFilename - Name for the temporary SRT file (default: 'temp_subtitles.srt')
 * @param {string} targetLanguage - Target language for subtitles (default: 'en')
 * @param {boolean} translateToEnglish - Whether to translate transcripts to English first (default: false)
 * @param {string} sourceLanguage - Source language for translation (default: 'auto')
 * @returns {Promise<Object>} Object containing Cloudinary URL and processing details
 */
async function processVideoWithSubtitles(videoUrl, relevantContent, srtFilename = 'temp_subtitles.srt', targetLanguage = 'en', translateToEnglish = true, sourceLanguage = 'auto') {
  let tempVideoPath = null;
  let srtFilePath = null;
  let outputVideoPath = null;
  const tempFiles = [];

  try {
    console.log('Starting video processing with subtitles...');
    console.log('Translation enabled:', translateToEnglish);
    
    // Step 1: Download video from URL
    console.log('Downloading video from URL...');
    tempVideoPath = await downloadVideoFromUrl(videoUrl);
    tempFiles.push(tempVideoPath);
    console.log('Video downloaded successfully');

    // Step 1.5: Translate transcripts to English if requested
   

    // Step 2: Generate SRT subtitles
    console.log('Generating SRT subtitles...');
    const srtContent = await generateSRTFromTranscripts(relevantContent, targetLanguage);
    srtFilePath = await saveSRTToFile(srtContent, srtFilename);
    tempFiles.push(srtFilePath);
    console.log('SRT subtitles generated successfully');

    // Step 3: Apply subtitles to video using FFmpeg
    console.log('Applying subtitles to video...');
    outputVideoPath = await applySubtitlesToVideo(tempVideoPath, srtFilePath);
    tempFiles.push(outputVideoPath);
    console.log('Subtitles applied successfully');

    // Step 4: Upload video to Cloudinary
    console.log('Uploading video to Cloudinary...');
    const videoBuffer = await fs.readFile(outputVideoPath);
    const cloudinaryUrl = await uploadVideoToCloudinary(videoBuffer);
    console.log('Video uploaded to Cloudinary successfully');
    console.log('cloudinaryUrl:', cloudinaryUrl);

    // Step 5: Clean up temporary files
    console.log('Cleaning up temporary files...');
    await cleanupTempFiles(tempFiles);

    return {
      success: true,
      cloudinaryUrl,
      processingDetails: {
        originalVideoUrl: videoUrl,
        subtitleCount: relevantContent.length,
        targetLanguage,
        translationApplied: translateToEnglish,
        sourceLanguage: translateToEnglish ? sourceLanguage : 'none',
        processingSteps: [
          'Video downloaded from URL',
          ...(translateToEnglish ? ['Transcripts translated to English'] : []),
          'SRT subtitles generated',
          'Subtitles applied using FFmpeg',
          'Video uploaded to Cloudinary',
          'Temporary files cleaned up'
        ]
      }
    };

  } catch (error) {
    console.error('Error in video processing with subtitles:', error);
    
    // Clean up any temporary files that were created
    if (tempFiles.length > 0) {
      console.log('Cleaning up temporary files due to error...');
      await cleanupTempFiles(tempFiles);
    }

    return {
      success: false,
      error: error.message,
      processingDetails: {
        originalVideoUrl: videoUrl,
        subtitleCount: relevantContent.length,
        targetLanguage,
        translationApplied: translateToEnglish,
        sourceLanguage: translateToEnglish ? sourceLanguage : 'none',
        errorStep: error.message
      }
    };
  }
}

/**
 * Converts seconds to SRT timestamp format (HH:MM:SS,mmm)
 * @param {number} seconds - Time in seconds
 * @returns {string} SRT timestamp format
 */
function secondsToSRTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`;
}

/**
 * Creates sequential timestamps for a continuous timeline
 * @param {Array} transcripts - Array of transcript objects with startTime and endTime
 * @returns {Array} Array of transcripts with sequential timestamps
 */
function createSequentialTimestamps(transcripts) {
  if (!transcripts || transcripts.length === 0) {
    return [];
  }

  // Sort transcripts by start time to ensure proper sequence
  const sortedTranscripts = [...transcripts].sort((a, b) => 
    parseFloat(a.startTime) - parseFloat(b.startTime)
  );

  const sequentialTranscripts = [];
  let currentTime = 0;

  for (const transcript of sortedTranscripts) {
    const originalDuration = parseFloat(transcript.endTime) - parseFloat(transcript.startTime);
    
    const sequentialTranscript = {
      ...transcript,
      startTime: currentTime,
      endTime: currentTime + originalDuration,
      originalStartTime: transcript.startTime,
      originalEndTime: transcript.endTime
    };
    
    sequentialTranscripts.push(sequentialTranscript);
    currentTime += originalDuration;
  }

  console.log('Sequential timestamps created:', sequentialTranscripts.map(t => 
    `${t.originalStartTime}-${t.originalEndTime} -> ${t.startTime}-${t.endTime}`
  ));

  return sequentialTranscripts;
}

/**
 * Generates SRT subtitle content from transcripts using OpenAI
 * @param {Array} relevantContent - Array of objects with nested transcripts
 * @param {string} targetLanguage - Target language for translation (default: 'en')
 * @returns {Promise<string>} SRT file content
 */
async function generateSRTFromTranscripts(relevantContent, targetLanguage = 'en') {
  if (!relevantContent || relevantContent.length === 0) {
    return '';
  }

  console.log('relevantContent:', relevantContent);

  try {
    // Extract and flatten transcripts from the nested structure
    const transcripts = [];
    
    // Check if this is mergedGroups structure (array of arrays) or relevantContent structure
    const isMergedGroupsStructure = relevantContent.length > 0 && Array.isArray(relevantContent[0]);
    
    if (isMergedGroupsStructure) {
      // Handle mergedGroups structure: [[{transcript1}, {transcript2}], [{transcript3}]]
      console.log('Processing mergedGroups structure');
      relevantContent.forEach((group, groupIndex) => {
        if (Array.isArray(group)) {
          group.forEach(transcript => {
            if (transcript.transcript && transcript.startTime !== undefined && transcript.endTime !== undefined) {
              transcripts.push({
                transcript: transcript.transcript,
                startTime: transcript.startTime,
                endTime: transcript.endTime,
                languageCode: transcript.languageCode || 'en'
              });
            }
          });
        }
      });
    } else {
      // Handle original relevantContent structure: [{transcripts: [{transcript1}, {transcript2}]}]
      console.log('Processing relevantContent structure');
      relevantContent.forEach(item => {
        if (item.transcripts && Array.isArray(item.transcripts)) {
          item.transcripts.forEach(transcript => {
            if (transcript.transcript && transcript.startTime !== undefined && transcript.endTime !== undefined) {
              transcripts.push({
                transcript: transcript.transcript,
                startTime: transcript.startTime,
                endTime: transcript.endTime,
                languageCode: transcript.languageCode || 'en'
              });
            }
          });
        }
      });
    }

    if (transcripts.length === 0) {
      console.warn('No valid transcripts found in relevantContent');
      return '';
    }

    console.log('Extracted transcripts:', transcripts);

    // Create sequential timestamps for continuous timeline
    const sequentialTranscripts = createSequentialTimestamps(transcripts);

    // Prepare transcript data for OpenAI with sequential timestamps and translation
    const transcriptData = [];
    
    for (let i = 0; i < sequentialTranscripts.length; i++) {
      const t = sequentialTranscripts[i];
      
      // Translate the transcript text
      console.log(`Translating transcript ${i + 1}/${sequentialTranscripts.length}...`);
      const translatedText = await translateTranscriptToEnglish(t.transcript);
      console.log("start time:", secondsToSRTTime(t.startTime));
      console.log("end time:", secondsToSRTTime(t.endTime));
      transcriptData.push({
        id: i + 1,
        originalText: t.transcript,
        translatedText: translatedText,
        startTime: t.startTime,  // Use sequential start time
        endTime: t.endTime       // Use sequential end time
      });
    }

    console.log('Translated transcript data:', transcriptData);

    const prompt = `
You are a professional subtitle file generator. Your task is to create high-quality English subtitles from the provided transcript segments and their translations.

Instructions:
1. Translate the text to natural, fluent English.
2. Break long segments into multiple short lines for subtitles.
3. Each subtitle must be at max 15 words long and at min 12 words(if possible). First find out the number of subtitles the transcript is divided into, then divide the time duration of the segment transcript among all subtitles equally.
4. All subtitles should be within the following time range(hh:mm:ss,mmm): (${secondsToSRTTime(transcriptData[0].startTime)} - ${secondsToSRTTime(transcriptData[transcriptData.length - 1].endTime)})
5. Ensure each subtitle line is synchronized with the corresponding transcript timestamp.
6. IMPORTANT: ENSURE that no 2 subtitles have same or overlapping timestamp.
7. Format the output as a valid SRT file with EXACT formatting.
8. IMPORTANT: All of the transcripts(in chunks) MUST be included in the SRT file.
9. Show the last subtitle till the end of transcript duration.

All of he subtitles must be shown before the end of the video.

IMPORTANT: Use EXACTLY this SRT format with no extra spaces or characters:
1
00:00:01,600 --> 00:00:03,000
Subtitle text here

2
00:00:03,000 --> 00:00:07,500
Another subtitle here

3
....

Transcript segments with timestamps:
${transcriptData.map(t => `Segment ${t.id}: "${t.originalText}" \n  Translated text: "${t.translatedText}" \n  (${secondsToSRTTime(t.startTime)} - ${secondsToSRTTime(t.endTime)})`).join('\n')}

Generate a complete SRT file. Return ONLY the SRT content in the exact format shown above, with no additional text, explanations, or formatting variations.
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a professional subtitle generator. Create clean, readable English subtitles in SRT format."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 2000
    });

    const srtContent = response.choices[0].message.content.trim();
    // Validate and clean the SRT content
    const cleanedSRT = validateAndCleanSRT(srtContent, transcriptData, relevantContent);
    console.log('cleanedSRT:', cleanedSRT);
    return cleanedSRT;
  } catch (error) {
    console.error('Error generating SRT from transcripts:', error);
    // Fallback: generate basic SRT without OpenAI
    return generateBasicSRT(relevantContent);
  }
}

/**
 * Validates and cleans SRT content to ensure proper formatting
 * @param {string} srtContent - Raw SRT content from OpenAI
 * @param {Array} originalData - Original transcript data for validation
 * @param {Array} relevantContent - Original relevantContent for fallback
 * @returns {string} Cleaned SRT content
 */
function validateAndCleanSRT(srtContent, originalData, relevantContent) {
  try {
    console.log('Raw SRT content:', srtContent);
    
    // Normalize line endings and split into subtitle blocks
    const normalizedContent = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalizedContent.split('\n\n').filter(block => block.trim());
    
    console.log('Number of blocks found:', blocks.length);
    
    let cleanedSRT = '';
    let subtitleIndex = 1;

    for (const block of blocks) {
      const lines = block.split('\n').filter(line => line.trim());
      console.log(`Processing block ${subtitleIndex}:`, lines);
      
      if (lines.length >= 3) {
        // Find the timestamp line (should contain -->)
        const timestampLine = lines.find(line => line.includes('-->'));
        const subtitleText = lines.filter(line => !line.includes('-->') && !/^\d+$/.test(line.trim())).join('\n');
        
        console.log(`Block ${subtitleIndex} - Timestamp line:`, timestampLine);
        console.log(`Block ${subtitleIndex} - Subtitle text:`, subtitleText);
        
        if (timestampLine && subtitleText.trim()) {
          // Validate timestamp format (HH:MM:SS,mmm --> HH:MM:SS,mmm)
          const timestampRegex = /^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}$/;
          
          if (timestampRegex.test(timestampLine.trim())) {
            cleanedSRT += `${subtitleIndex}\n${timestampLine.trim()}\n${subtitleText.trim()}\n\n`;
            subtitleIndex++;
            console.log(`Block ${subtitleIndex - 1} - Valid subtitle added`);
          } else {
            console.warn(`Block ${subtitleIndex} - Invalid timestamp format:`, timestampLine);
            // Try to fix common timestamp issues
            const fixedTimestamp = fixTimestampFormat(timestampLine);
            if (fixedTimestamp) {
              cleanedSRT += `${subtitleIndex}\n${fixedTimestamp}\n${subtitleText.trim()}\n\n`;
              subtitleIndex++;
              console.log(`Block ${subtitleIndex - 1} - Fixed subtitle added`);
            }
          }
        } else {
          console.warn(`Block ${subtitleIndex} - Missing timestamp or subtitle text`);
        }
      } else {
        console.warn(`Block ${subtitleIndex} - Insufficient lines:`, lines.length);
      }
    }

    // If no valid subtitles found, fall back to basic SRT
    if (!cleanedSRT.trim()) {
      console.log('No valid SRT content found, using fallback');
      return generateBasicSRT(relevantContent);
    }

    console.log('Cleaned SRT content:', cleanedSRT);
    return cleanedSRT.trim();
  } catch (error) {
    console.error('Error validating SRT content:', error);
    return generateBasicSRT(relevantContent);
  }
}

/**
 * Attempts to fix common timestamp formatting issues
 * @param {string} timestampLine - The timestamp line to fix
 * @returns {string|null} Fixed timestamp line or null if unfixable
 */
function fixTimestampFormat(timestampLine) {
  try {
    // Remove extra whitespace
    let fixed = timestampLine.trim();
    
    // Replace different arrow styles
    fixed = fixed.replace(/->/g, '-->').replace(/→/g, '-->');
    
    // Fix common separator issues
    fixed = fixed.replace(/\s*-->\s*/g, ' --> ');
    
    // Try to extract and validate time parts
    const parts = fixed.split(' --> ');
    if (parts.length === 2) {
      const startTime = parts[0].trim();
      const endTime = parts[1].trim();
      
      // Basic validation that we have time-like strings
      if (startTime.includes(':') && endTime.includes(':') && 
          startTime.includes(',') && endTime.includes(',')) {
        return `${startTime} --> ${endTime}`;
      }
    }
    
    return null;
  } catch (error) {
    console.warn('Error fixing timestamp format:', error);
    return null;
  }
}

/**
 * Generates basic SRT content as fallback without OpenAI
 * @param {Array} relevantContent - Array of objects with nested transcripts
 * @returns {string} Basic SRT content
 */
function generateBasicSRT(relevantContent) {
  let srtContent = '';
  
  // Extract and flatten transcripts from the nested structure
  const transcripts = [];
  relevantContent.forEach(item => {
    if (item.transcripts && Array.isArray(item.transcripts)) {
      item.transcripts.forEach(transcript => {
        if (transcript.transcript && transcript.startTime !== undefined && transcript.endTime !== undefined) {
          transcripts.push({
            transcript: transcript.transcript,
            startTime: transcript.startTime,
            endTime: transcript.endTime
          });
        }
      });
    }
  });

  if (transcripts.length === 0) {
    console.warn('No valid transcripts found in relevantContent for basic SRT generation');
    return '';
  }
  
  // Create sequential timestamps for continuous timeline
  const sequentialTranscripts = createSequentialTimestamps(transcripts);

  sequentialTranscripts.forEach((transcript, index) => {
    const startTime = secondsToSRTTime(transcript.startTime);  // Use sequential time
    const endTime = secondsToSRTTime(transcript.endTime);      // Use sequential time
    const text = transcript.transcript.trim();
    
    // Split long text into multiple lines if needed
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    
    for (const word of words) {
      if ((currentLine + word).length <= 42) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    
    srtContent += `${index + 1}\n${startTime} --> ${endTime}\n${lines.join('\n')}\n\n`;
  });
  
  return srtContent.trim();
}

/**
 * Saves SRT content to a file
 * @param {string} srtContent - SRT file content
 * @param {string} filename - Output filename
 * @returns {Promise<string>} Path to the saved file
 */
async function saveSRTToFile(srtContent, filename) {
  const fs = require('fs').promises;
  const path = require('path');
  
  const outputPath = path.join('/tmp', filename);
  await fs.writeFile(outputPath, srtContent, 'utf8');
  
  return outputPath;
}

/**
 * Generates SRT file from transcripts and saves it
 * @param {Array} relevantContent - Array of objects with nested transcripts
 * @param {string} outputFilename - Output filename (default: 'subtitles.srt')
 * @param {string} targetLanguage - Target language (default: 'en')
 * @returns {Promise<Object>} Object containing file path and content
 */
async function generateAndSaveSRT(relevantContent, outputFilename = 'subtitles.srt', targetLanguage = 'en') {
  const srtContent = await generateSRTFromTranscripts(relevantContent, targetLanguage);
  const filePath = await saveSRTToFile(srtContent, outputFilename);
  
  return {
    filePath,
    content: srtContent,
    filename: outputFilename
  };
}

/**
 * Translates a single transcript text to English using OpenAI
 * @param {string} transcriptText - The transcript text to translate
 * @param {string} sourceLanguage - Source language code (default: 'auto')
 * @returns {Promise<string>} Translated English text
 */
async function translateTranscriptToEnglish(transcriptText, sourceLanguage = 'auto') {
  if (!transcriptText || typeof transcriptText !== 'string') {
    throw new Error('Invalid transcript text provided');
  }

  console.log('Translating transcript to English...');
  console.log('Source language:', sourceLanguage);
  console.log('Original text:', transcriptText.substring(0, 100) + '...');

  try {
    const prompt = `
You are a professional translator. Translate the following text to clear, natural English while maintaining the original meaning and context.

Instructions:
1. Translate the text to natural, fluent English
2. Preserve the original meaning and context
4. Maintain any technical terms or proper nouns appropriately
5. Return ONLY the translated text, no additional text or explanations

Text to translate:
"${transcriptText}"

Translated text:`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a professional translator. Translate the given text to natural English and return only the translated text."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 1000
    });

    const translatedText = response.choices[0].message.content.trim();
    console.log('Translation completed:', translatedText.substring(0, 100) + '...');
    
    return translatedText;

  } catch (error) {
    console.error('Error translating transcript to English:', error);
    throw new Error(`Translation failed: ${error.message}`);
  }
}

module.exports = {
  generateSRTFromTranscripts,
  generateAndSaveSRT,
  saveSRTToFile,
  secondsToSRTTime,
  generateBasicSRT,
  processVideoWithSubtitles,
  translateTranscriptToEnglish,
  createSequentialTimestamps,
  generateSRTFromChunks,
  processVideoWithChunkedSubtitles
    }; 
