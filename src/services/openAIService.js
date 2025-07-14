const { OpenAI } = require('openai');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const {selectMostRelevantShotsWithin30sGreedy} = require('./visualAnalysisService');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Robust fallback function to extract data from malformed AI responses
 * @param {string} text - The response text from AI
 * @param {Object} expectedStructure - Expected structure with default values
 * @returns {Object} - Extracted data with fallback values
 */
function extractDataFromMalformedResponse(text, expectedStructure) {
  const result = { ...expectedStructure };
  
  try {
    // Try to extract key-value pairs using regex
    const keyValueRegex = /"([^"]+)"\s*:\s*"([^"]+)"/g;
    let match;
    
    while ((match = keyValueRegex.exec(text)) !== null) {
      const key = match[1];
      const value = match[2];
      
      if (key in expectedStructure) {
        // Try to convert value to appropriate type
        if (typeof expectedStructure[key] === 'boolean') {
          result[key] = value.toLowerCase() === 'true';
        } else if (typeof expectedStructure[key] === 'number') {
          result[key] = parseFloat(value) || expectedStructure[key];
        } else if (Array.isArray(expectedStructure[key])) {
          // For arrays, try to find array-like content
          const arrayMatch = text.match(new RegExp(`"${key}"\\s*:\\s*\\[(.*?)\\]`, 's'));
          if (arrayMatch) {
            try {
              result[key] = JSON.parse(`[${arrayMatch[1]}]`);
            } catch (e) {
              result[key] = expectedStructure[key];
            }
          }
        } else {
          result[key] = value;
        }
      }
    }
    
    return result;
  } catch (error) {
    console.error('Failed to extract data from malformed response:', error);
    return expectedStructure;
  }
}

/**
 * Utility function to parse JSON from OpenAI responses that may be wrapped in markdown code blocks
 * @param {string} text - The response text from OpenAI
 * @param {Object} fallbackStructure - Optional fallback structure if parsing fails
 * @returns {Object} - Parsed JSON object
 * @throws {Error} - If JSON parsing fails and no fallback is provided
 */
function parseOpenAIResponse(text, fallbackStructure = null) {
  if (!text || typeof text !== 'string') {
    if (fallbackStructure) {
      return fallbackStructure;
    }
    throw new Error('Invalid input: text must be a non-empty string');
  }

  // Handle responses wrapped in markdown code blocks
  let jsonText = text;
  
  // Remove markdown code block formatting if present
  if (text.includes('```json')) {
    jsonText = text.replace(/```json\s*/, '').replace(/\s*```/, '');
  } else if (text.includes('```')) {
    jsonText = text.replace(/```\s*/, '').replace(/\s*```/, '');
  }
  
  // Clean up common formatting issues
  jsonText = jsonText
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Find the first JSON object
  const jsonStart = jsonText.indexOf('{');
  const jsonEnd = jsonText.lastIndexOf('}');
  
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    // Try to find array format
    const arrayStart = jsonText.indexOf('[');
    const arrayEnd = jsonText.lastIndexOf(']');
    
    if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
      if (fallbackStructure) {
        console.warn('No JSON found in response, using fallback structure');
        return extractDataFromMalformedResponse(text, fallbackStructure);
      }
      throw new Error('No JSON object or array found in response');
    }
    
    // Extract array content
    const arrayContent = jsonText.slice(arrayStart, arrayEnd + 1);
    return JSON.parse(arrayContent);
  }
  
  // Extract JSON object content
  const jsonContent = jsonText.slice(jsonStart, jsonEnd + 1);
  
  try {
    return JSON.parse(jsonContent);
  } catch (parseError) {
    // Try to fix common JSON issues
    let fixedContent = jsonContent
      .replace(/(\d+)s/g, '$1') // Remove 's' suffix from numbers
      .replace(/''/g, '"') // Replace double single quotes with double quotes
      .replace(/'/g, '"') // Replace single quotes with double quotes
      .replace(/\.\./g, '.') // Replace double dots with single dot
      .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
      .replace(/([^"\\])\\([^"\\])/g, '$1\\\\$2'); // Fix escape sequences
    
    try {
      return JSON.parse(fixedContent);
    } catch (secondError) {
      console.error('Original JSON content:', jsonContent);
      console.error('Fixed JSON content:', fixedContent);
      
      if (fallbackStructure) {
        console.warn('JSON parsing failed, using fallback structure');
        return extractDataFromMalformedResponse(text, fallbackStructure);
      }
      
      throw new Error(`Failed to parse JSON after cleaning: ${secondError.message}`);
    }
  }
}

async function extractFramesForTimestamp(videoBuffer, startTime, endTime, frameRate = 0.25, maxFrames = 3) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const tempDir = '/tmp';
    
    const outputPattern = path.join(tempDir, `frame_${startTime}_%d.jpg`);

    // Create a temporary file to store the video buffer
    const tempVideoPath = path.join(tempDir, `temp_video_${Date.now()}.mp4`);
    fs.writeFileSync(tempVideoPath, videoBuffer);

    ffmpeg(tempVideoPath)
      .setStartTime(startTime)
      .setDuration(endTime - startTime)
      .fps(frameRate)
      .on('end', async () => {
        try {
          // Read all frames from temp directory
          const files = fs.readdirSync(tempDir)
            .filter(file => file.startsWith(`frame_${startTime}_`))
            .sort((a, b) => {
              const numA = parseInt(a.split('_').pop());
              const numB = parseInt(b.split('_').pop());
              return numA - numB;
            });

          // Limit the number of frames to maxFrames
          const limitedFiles = files.slice(0, maxFrames);

          // Read each frame file
          for (const file of limitedFiles) {
            const framePath = path.join(tempDir, file);
            const frameBuffer = fs.readFileSync(framePath);
            frames.push(frameBuffer);
            // Clean up the file
            fs.unlinkSync(framePath);
          }

          // Clean up any remaining frame files
          for (const file of files.slice(maxFrames)) {
            const framePath = path.join(tempDir, file);
            if (fs.existsSync(framePath)) {
              fs.unlinkSync(framePath);
            }
          }

          // Clean up the temporary video file
          fs.unlinkSync(tempVideoPath);

          resolve(frames);
        } catch (error) {
          // Clean up the temporary video file in case of error
          if (fs.existsSync(tempVideoPath)) {
            fs.unlinkSync(tempVideoPath);
          }
          reject(error);
        }
      })
      .on('error', (err) => {
        // Clean up the temporary video file in case of error
        if (fs.existsSync(tempVideoPath)) {
          fs.unlinkSync(tempVideoPath);
        }
        reject(err);
      })
      .save(outputPattern);
  });
}


/**
 * Analyzes the entire content to determine the main topic, news category, and relevance
 * @param {Array} transcripts - Array of transcript objects
 * @returns {Promise<Object>} Main topic and news analysis
 */
async function analyzeMainTopic(transcripts,description) {
  const combinedTranscript = transcripts.map(t => t.transcript).join(' ');
  
  const prompt = `
You are an expert content analyzer.

Your task is to analyze the transcript and provide insights about the video content. However, please keep in mind:
- The transcript may be very short(like few random words), incomplete, or contain minimal/no useful information.
- IMPORTANT: The "is_sufficient" field should be determined ONLY by the given transcript,${description ? `NOT by the description` : ""}. A transcript is considered insufficient if it contains few words, and lacks meaningful information.

Here is the complete transcript of a video:
"${combinedTranscript}"

${description ? `Here is the description about the video:
"${description}"` : ""}

Analyze this content and provide:
1. The main topic or subject being discussed( if detectable )
3. what general news category it belongs to for example: politics/human rights/technology/sports/entertainment/social/natural disaster/economy/environment/war/crime/celebration/(etc...)
4. Is it AI generated or not?
5. Is the transcript sufficient for analysis? (true if transcript contains meaningful information, coherent content; false if transcript is too short containing few random words, or lacks meaningful information)

Return result as JSON with this format:
{
  "main_topic": "Brief description of the main topic",
  "summary": "A short news article of 2-3 sentences",
  "category":"News category",
  "is_ai_generated": true/false,
  "is_sufficient": true/false
  }
`;

  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4
  });

  const text = response.choices[0].message.content;
  
  try {
    return parseOpenAIResponse(text);
  } catch (e) {
    console.error("Failed to parse OpenAI response for main topic:", text);
    return {
      main_topic: "Unknown topic",
      summary: "Failed to analyze main topic",
      category: "other",
      is_sufficient: false
    };
  }
}

/**
 * Analyzes a transcript segment and its corresponding image frames to determine if it's a voiceover or has a visible speaker
 * @param {Object} transcript - Transcript object with transcript and timestamps
 * @param {Array} frames - Array of image frames corresponding to the transcript timestamp
 * @returns {Promise<Object>} Voice type analysis
 */
async function analyzeVoiceTypeWithFrames(transcript, frames) {
  try {
    // Convert frames to base64 strings if they aren't already
    const frameDescriptions = frames.map(frame => {
      // If frame is a base64 string, use it directly
      if (typeof frame === 'string' && frame.startsWith('data:image')) {
        return frame;
      }
      // If frame is a buffer or other format, convert to base64
      return `data:image/jpeg;base64,${frame.toString('base64')}`;
    });

    const prompt = `
You are a multimodal content analyst. Your task is to determine whether the speaker in the transcript segment is visually present on screen during the same time interval.

Use both:
- The transcript text (including tone, language, and context)
- The corresponding video frames (captured during the same timestamps)

Transcript segment:
"${transcript.transcript}"

Time Range: ${transcript.startTime}s to ${transcript.endTime}s

Visual Input:
You are also provided with a series of frames (images) captured from the video during this time range. Carefully analyze these images for the presence of a visible speaker (person talking on screen).

Evaluate based on:
1. The style of speech (formal narration vs. casual conversation).
2. Presence of first-person language or direct address to the viewer.
3. Visual cues — Is there the same person in multiple frames who appears to be speaking? (e.g., open mouth, eye contact, gestures).
4. Matching tone and context between what's said and what's shown.

Return result as JSON in the following format:

{
  "voice_type": "speaker_visible" or "voiceover",
  "confidence": "high" | "medium" | "low",
  "explanation": "Short explanation of how both transcript and frames support this classification"
}
`;

    // Create content array with text and images
    const content = [
      {
        type: "text",
        text: prompt
      },
      ...frameDescriptions.map(frame => ({
        type: "image_url",
        image_url: {
          url: frame
        }
      }))
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: content
        }
      ],
      max_tokens: 300
    });

    const text = response.choices[0].message.content;
    
    try {
      const result = parseOpenAIResponse(text);
      return result;
    } catch (e) {
      console.error("Failed to parse OpenAI response for voice type:", text);
      return {
        voice_type: "unknown",
        confidence: "low",
        explanation: "Failed to analyze voice type"
      };
    }
  } catch (error) {
    console.error("Error in analyzeVoiceTypeWithFrames:", error);
    return {
      voice_type: "unknown",
      confidence: "low",
      explanation: "Error processing analysis"
    };
  }
}

/**
 * Merges transcripts that are close in time (within 8 seconds)
 * @param {Array} transcripts - Array of transcript objects
 * @returns {Array} Array of merged transcript groups
 */
function mergeCloseTranscripts(transcripts) {
  if (!transcripts || transcripts.length === 0) return [];
  
  // // Sort transcripts by start time
  // const sortedTranscripts = [...transcripts].sort((a, b) => 
  //   parseFloat(a.startTime) - parseFloat(b.startTime)
  // );
  
  const mergedGroups = [];
  let currentGroup = [transcripts[0]];
  
  for (let i = 1; i < transcripts.length; i++) {
    const current = transcripts[i];
    const lastInGroup = currentGroup[currentGroup.length - 1];
    
    // Check if current transcript is within 3 seconds of the last transcript in the group
    const timeGap = parseFloat(current.startTime) - parseFloat(lastInGroup.endTime);
    
    if (timeGap <= 3) {

      

      // Merge into current group
      currentGroup.push(current);
      
    } else {
      // Start new group
      mergedGroups.push(currentGroup);
      currentGroup = [current];
    }
    
  }
  
  // Add the last group
  if (currentGroup.length > 0) {
    mergedGroups.push(currentGroup);
  }
  
  return mergedGroups;
}

/**
 * Finds relevant shots that correspond to the given transcript timestamps
 * @param {Array} relevantTranscripts - Array of relevant transcript objects with startTime and endTime
 * @param {Array} allShots - Array of all shot objects with startTime and endTime
 * @returns {Array} Array of relevant shots that overlap with transcript timestamps
 */
function findRelevantShotsForTranscripts(relevantTranscripts, allShots) {
  if (!relevantTranscripts || relevantTranscripts.length === 0 || !allShots || allShots.length === 0) {
    return [];
  }

  const relevantShots = [];

  // For each relevant transcript, find shots that overlap with its time range
  for (const transcript of relevantTranscripts) {
    const transcriptStartTime = parseFloat(transcript.startTime);
    const transcriptEndTime = parseFloat(transcript.endTime);

    // Find shots that overlap with this transcript's time range
    const overlappingShots = allShots.filter(shot => {
      const shotStartTime = parseFloat(shot.startTime).toFixed(1);
      const shotEndTime = parseFloat(shot.endTime).toFixed(1);

      // Check for overlap: shot overlaps with transcript if:
      // 1. Shot starts within transcript time range, OR
      // 2. Shot ends within transcript time range, OR
      // 3. Shot completely contains transcript time range, OR
      // 4. Transcript completely contains shot time range
      const shotStartsInTranscript = shotStartTime >= transcriptStartTime && shotStartTime < transcriptEndTime;
      const shotEndsInTranscript = shotEndTime > transcriptStartTime && shotEndTime <= transcriptEndTime;
      const shotContainsTranscript = shotStartTime <= transcriptStartTime && shotEndTime >= transcriptEndTime;
      const transcriptContainsShot = transcriptStartTime <= shotStartTime && transcriptEndTime >= shotEndTime;

      return shotStartsInTranscript || shotEndsInTranscript || shotContainsTranscript || transcriptContainsShot;
    });

    // Add overlapping shots to relevant shots array
    relevantShots.push(...overlappingShots);
  }

  // Remove duplicates (in case multiple transcripts overlap with the same shot)
  const uniqueRelevantShots = relevantShots.filter((shot, index, self) => 
    index === self.findIndex(s => 
      parseFloat(s.startTime) === parseFloat(shot.startTime) && 
      parseFloat(s.endTime) === parseFloat(shot.endTime)
    )
  );

  // Sort by start time
  uniqueRelevantShots.sort((a, b) => parseFloat(a.startTime) - parseFloat(b.startTime));

  return uniqueRelevantShots;
}

/**
 * Groups transcripts into relevant (main topic) and irrelevant content
 * @param {Array} transcripts - Array of transcript objects with transcript, language, startTime, endTime
 * @param {Buffer} videoBuffer - Video file buffer
 * @returns {Promise<Object>} Object containing relevant and irrelevant groups
 */
async function groupRelatedTranscripts(transcripts,speechTranscripts, videoBuffer,shots,mainTopic) {
  const relevantGroup = [];
  const irrelevantGroup = [];

  // First, analyze the entire content to understand the main topic and news category
  const mainTopicAnalysis = mainTopic;
  
  for (const transcript of transcripts) {
    const prompt = `
Analyze if this transcript segment is relevant and important to the main topic.

Main topic: "${mainTopicAnalysis.main_topic}"
Segment: "${transcript.transcript}"

Assess relevance and importance. Return JSON:
{
  "is_relevant": true/false,
  "importanceScore": 0-100(how important is this segment to the main topic)
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4
    });

    const text = response.choices[0].message.content;
    
    try {
      const result = parseOpenAIResponse(text);
      
      if (result.is_relevant) {
        relevantGroup.push({
          ...transcript,
          relevanceScore: result.importanceScore,
        });
      } else {
        irrelevantGroup.push({
          ...transcript,
          relevanceScore: result.importanceScore,
        });
      }
    } catch (e) {
      console.error("Failed to parse OpenAI response for transcript relevance:", text);
      relevantGroup.push({
        ...transcript,
        relevanceScore: 0
      });
    }
  }

  const mergedContentWithVoiceType=await analyzeSpeakerPresenceForRelevantGroup(relevantGroup,videoBuffer);
  console.log('ContentWithVoiceType:',mergedContentWithVoiceType);
  
  // Check if any merged content has a visible speaker with high confidence
  const speakerPresent = mergedContentWithVoiceType.some(content => 
    content.analysis.voice_type === 'speaker_visible' && 
    content.analysis.confidence === 'high'
  );
  let relevantSentences = [];
  let selectedShots;
  let totalDuration;
  if(speakerPresent){
    console.log('speakerPresent:',speakerPresent);

    // Break down relevant transcripts into sentences
    //relevantSentences = breakDownRelevantTranscriptsIntoSentences(speechTranscripts, relevantGroup);
    //relevantSentences=await divideTranscriptsIntoSentencesWithAI(relevantGroup,speechTranscripts);
    //console.log('Relevant sentences:', relevantSentences);
    const result= selectMostRelevantShotsWithin30sGreedy(relevantGroup,speakerPresent);
    selectedShots=result.selectedShots;
    totalDuration=result.totalDuration;

  }
  else{
    //Find shots that corresponds to the relevant transcripts
    const relevantShots=findRelevantShotsForTranscripts(relevantGroup,shots);
    const result= selectMostRelevantShotsWithin30sGreedy(relevantShots,speakerPresent);
    selectedShots=result.selectedShots;
    totalDuration=result.totalDuration;
    console.log('relevantShots:',relevantShots);
    console.log('relevantGroup:',relevantGroup);


  }
  
  const mergedGroups = mergeCloseTranscripts(selectedShots);
  
  // Create merged and unmerged content sections
  const mergedContent = mergedGroups.map(group => ({
    transcripts: group,
    startTime: group[0].startTime,
    endTime: group[group.length - 1].endTime
  }));


  
  const unmergedContent = relevantGroup.filter(transcript => 
    !mergedGroups.some(group => group.includes(transcript))
  ).map(transcript => ({
    transcripts: [transcript],
    startTime: transcript.startTime,
    endTime: transcript.endTime
  }));

  return {
    main_topic: mainTopicAnalysis.main_topic,
    summary: mainTopicAnalysis.summary,
    category: mainTopicAnalysis.category,
    is_ai_generated: mainTopicAnalysis.is_ai_generated,
    speaker_present: speakerPresent,
    relevant_content: {
       mergedContent,
       sentences: relevantSentences
    },
    irrelevant_content: {
      transcripts: irrelevantGroup,
      startTime: irrelevantGroup[0]?.startTime || "0",
      endTime: irrelevantGroup[irrelevantGroup.length - 1]?.endTime || "0"
    },
    totalDuration
  };
}

/**
 * For each transcript in the relevant group, extract frames and analyze for speaker presence
 * @param {Array} relevantGroup - Array of relevant transcript objects (with transcript, startTime, endTime, relevanceScore)
 * @param {Buffer} videoBuffer - The video file buffer
 * @param {number} frameRate - Frames per second to extract (default 0.25 - one frame every 4 seconds)
 * @returns {Promise<Array>} Array of results for each transcript in the relevant group
 */
async function analyzeSpeakerPresenceForRelevantGroup(relevantGroup, videoBuffer, frameRate = 0.25) {
  const results = [];
  for (const transcript of relevantGroup) {
    const { startTime, endTime, transcript: transcriptText, relevanceScore } = transcript;
    
    // Create transcript object for analysis
    const transcriptForAnalysis = {
      transcript: transcriptText,
      startTime,
      endTime
    };
    
    // Extract frames for this time range with reduced frame rate
    const frames = await extractFramesForTimestamp(videoBuffer, startTime, endTime, frameRate);
    
    // Analyze speaker presence
    const analysis = await analyzeVoiceTypeWithFrames(transcriptForAnalysis, frames);
    
    results.push({
      startTime,
      endTime,
      analysis,
      transcript: transcriptText,
      relevanceScore
    });
  }
  return results;
}

/**
 * Breaks down relevant group transcripts into sentences by matching with speech transcripts
 * @param {Array} speechTranscripts - Array of speech transcript objects with words and timestamps
 * @param {Array} relevantGroup - Array of relevant transcript objects with startTime, endTime, transcript
 * @returns {Array} Array of sentence objects with transcript, startTime, endTime
 */
function breakDownRelevantTranscriptsIntoSentences(speechTranscripts, relevantGroup) {
  const sentences = [];
  
  // For each relevant transcript, find matching speech transcript and break into sentences
  for (const relevantTranscript of relevantGroup) {
    const relevantStartTime = parseFloat(relevantTranscript.startTime);
    const relevantEndTime = parseFloat(relevantTranscript.endTime);
    
    // Find speech transcript that overlaps with this relevant transcript
    const matchingSpeechTranscript = speechTranscripts.find(speech => {
      // Check if there's any overlap between the time ranges
      const speechWords = speech.words;
      if (speechWords.length === 0) return false;
      
      const speechStartTime = speechWords[0].startTime;
      const speechEndTime = speechWords[speechWords.length - 1].endTime;
      
      // Check for overlap
      return (speechStartTime <= relevantEndTime && speechEndTime >= relevantStartTime);
    });
    
    if (!matchingSpeechTranscript) {
      // If no matching speech transcript found, add the entire relevant transcript as one sentence
      sentences.push({
        transcript: relevantTranscript.transcript,
        startTime: relevantTranscript.startTime,
        endTime: relevantTranscript.endTime,
        relevanceScore: relevantTranscript.relevanceScore
      });
      continue;
    }
    
    // Find words that fall within the relevant transcript time range
    const relevantWords = matchingSpeechTranscript.words.filter(word => {
      return word.startTime >= relevantStartTime && word.endTime <= relevantEndTime;
    });
    
    if (relevantWords.length === 0) {
      // If no words found in the time range, add the entire relevant transcript
      sentences.push({
        transcript: relevantTranscript.transcript,
        startTime: relevantTranscript.startTime,
        endTime: relevantTranscript.endTime,
        relevanceScore: relevantTranscript.relevanceScore
      });
      continue;
    }
    
    // Break down into sentences by finding words that end with '.'
    let currentSentence = [];
    let sentenceStartTime = relevantWords[0].startTime;
    
    for (let i = 0; i < relevantWords.length; i++) {
      const word = relevantWords[i];
      currentSentence.push(word);
      
      // Check if this word ends with a period (indicating end of sentence)
      if (word.word.trim().endsWith('.')) {
        // Create sentence object
        const sentenceText = currentSentence.map(w => w.word).join(' ');
        const sentenceEndTime = word.endTime;
        
        sentences.push({
          transcript: sentenceText,
          startTime: sentenceStartTime,
          endTime: sentenceEndTime,
          relevanceScore: relevantTranscript.relevanceScore
        });
        
        // Reset for next sentence
        currentSentence = [];
        if (i + 1 < relevantWords.length) {
          sentenceStartTime = relevantWords[i + 1].startTime;
        }
      }
    }
    
    // If there are remaining words that don't end with a period, add them as the last sentence
    if (currentSentence.length > 0) {
      const sentenceText = currentSentence.map(w => w.word).join(' ');
      const sentenceEndTime = currentSentence[currentSentence.length - 1].endTime;
      
      sentences.push({
        transcript: sentenceText,
        startTime: sentenceStartTime,
        endTime: sentenceEndTime,
        relevanceScore: relevantTranscript.relevanceScore
      });
    }
  }
  
  return sentences;
}

/**
 * Divides relevant transcripts into sentences using OpenAI with proper timestamps
 * @param {Array} relevantTranscripts - Array of relevant transcript objects with transcript, startTime, endTime
 * @param {Array} speechTranscripts - Array of speech transcript objects with words and timestamps
 * @returns {Promise<Array>} Array of sentence objects with transcript, startTime, endTime
 */


async function divideTranscriptsIntoSentencesWithAI(relevantTranscripts, speechTranscripts) {
  const sentences = [];
  
  for (const relevantTranscript of relevantTranscripts) {
    const relevantStartTime = parseFloat(relevantTranscript.startTime);
    const relevantEndTime = parseFloat(relevantTranscript.endTime);
    
    // Find speech transcript that overlaps with this relevant transcript
    const matchingSpeechTranscript = speechTranscripts.find(speech => {
      const speechWords = speech.words;
      if (speechWords.length === 0) return false;
      
      const speechStartTime = speechWords[0].startTime;
      const speechEndTime = speechWords[speechWords.length - 1].endTime;
      
      // Check for overlap
      return (speechStartTime == relevantStartTime && speechEndTime == relevantEndTime);
    });
    
    if (!matchingSpeechTranscript) {
      // If no matching speech transcript found, add the entire relevant transcript as one sentence
      console.log('No matching speech transcript found, adding the entire relevant transcript as one sentence');
      sentences.push({
        transcript: relevantTranscript.transcript,
        startTime: relevantTranscript.startTime,
        endTime: relevantTranscript.endTime,
        relevanceScore: relevantTranscript.relevanceScore || 0,
        words: [] // Empty words array since no matching transcript found
      });
      continue;
    }
    
    // Prepare the transcript text and words for AI analysis
    const transcriptText = relevantTranscript.transcript;
    const wordsWithTimestamps = matchingSpeechTranscript.words.map(word => ({
      word: word.word,
      startTime: word.startTime,
      endTime: word.endTime
    }));
    const systemPrompt=`
    You are a transcript analyzer. Your task is to divide the given transcript into smaller meaningful sentences based in the meanings and the stops in snetences(like full stops).
    e.g. "My name is a bot. I am a robot." should be divided into two sentences: "My name is a bot." and "I am a robot."
    For "My name is a bot" sentence, the startTime will be the startTime of the first word "My" and the endTime will be the endTime of the last word "bot".
    The startTime and endTime of words will be provided in the wordsWithTimestamps array.You just have to find the words.
    
    `;
    const prompt = `Break this transcript into smaller meaningful sentences based in the meanings and the stops in sentences(like full stops).Return these sentences with accurate timestamp for each resultant sentence.

Transcript: "${transcriptText}"

Words of this transcript with timestamps:
${wordsWithTimestamps.map(w => `"${w.word}" (${w.startTime}s - ${w.endTime}s)`).join('\n')}

Return the result as JSON in this format:
{
  "sentences": [
    {
      "sentence": "The actual sentence text",
      "startTime": 12.5,
      "endTime": 15.2 
    }
  ]
}
`;

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ],
        temperature: 0.3
      });

      const text = response.choices[0].message.content;
      const result = parseOpenAIResponse(text);
      
      if (result.sentences && Array.isArray(result.sentences)) {
        // Add each sentence to the results with words array
        result.sentences.forEach(sentenceData => {
          const sentenceStartTime = parseFloat(sentenceData.startTime);
          const sentenceEndTime = parseFloat(sentenceData.endTime);
          
          // Find words that fall within this sentence's time range
          const sentenceWords = matchingSpeechTranscript.words.filter(word => {
            const wordStartTime = parseFloat(word.startTime);
            const wordEndTime = parseFloat(word.endTime);
            
            // Check if word overlaps with sentence time range
            return (wordStartTime >= sentenceStartTime && wordEndTime <= sentenceEndTime)
          });

          // Sort words by start time to ensure proper order
          sentenceWords.sort((a, b) => parseFloat(a.startTime) - parseFloat(b.startTime));

          sentences.push({
            transcript: sentenceData.sentence,
            startTime: sentenceData.startTime,
            endTime: sentenceData.endTime,
            relevanceScore: relevantTranscript.relevanceScore || 0,
            words: sentenceWords // Add the words array to each sentence
          });
        });
      } else {
        // Fallback: add the entire transcript as one sentence
        console.log('No sentences found, adding the entire relevant transcript as one sentence');
        
        // Find words for the entire transcript
        const sentenceWords = matchingSpeechTranscript.words.filter(word => {
          const wordStartTime = parseFloat(word.startTime);
          const wordEndTime = parseFloat(word.endTime);
          
          return (wordEndTime >= relevantStartTime && wordEndTime <= relevantEndTime) 
        });

        sentenceWords.sort((a, b) => parseFloat(a.startTime) - parseFloat(b.startTime));

        sentences.push({
          transcript: relevantTranscript.transcript,
          startTime: relevantTranscript.startTime,
          endTime: relevantTranscript.endTime,
          relevanceScore: relevantTranscript.relevanceScore || 0,
          words: sentenceWords
        });
      }
    } catch (error) {
      console.error("Failed to divide transcript into sentences with AI:", error);
      // Fallback: add the entire transcript as one sentence
      console.log('Failed to divide transcript into sentences with AI, adding the entire relevant transcript as one sentence');
      
      // Find words for the entire transcript
      const sentenceWords = matchingSpeechTranscript.words.filter(word => {
        const wordStartTime = parseFloat(word.startTime);
        const wordEndTime = parseFloat(word.endTime);
        
        return (wordEndTime >= relevantStartTime && wordEndTime <= relevantEndTime) 
      });

      sentenceWords.sort((a, b) => parseFloat(a.startTime) - parseFloat(b.startTime));

      sentences.push({
        transcript: relevantTranscript.transcript,
        startTime: relevantTranscript.startTime,
        endTime: relevantTranscript.endTime,
        relevanceScore: relevantTranscript.relevanceScore || 0,
        words: sentenceWords
      });
    }
  }
  
  return sentences;
}

/**
 * Adds proper punctuation to text using OpenAI
 * @param {string} text - Text without proper punctuation
 * @param {string} language - Language code (optional, for better accuracy)
 * @returns {Promise<string>} Text with proper punctuation
 */
async function addPunctuationToText(text, language = 'auto') {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text provided');
  }

  console.log('Adding punctuation to text:', text.substring(0, 100) + '...');

  try {
    const prompt = `
You are a professional text editor. Your task is to add proper punctuation to the given text, especially full stops (periods) where sentences naturally end.

Instructions:
1. Add proper punctuation marks including periods, commas, question marks, exclamation marks
2. Focus especially on adding full stops (periods) at the end of complete sentences
3. Maintain the original meaning and flow of the text
4. Preserve any existing punctuation that is correct
5. Return ONLY the punctuated text, no additional text or explanations

${language !== 'auto' ? `Note: The text is in ${language} language.` : ''}

Text to punctuate:
"${text}"

Punctuated text:`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a professional text editor. Add proper punctuation to the given text and return only the punctuated text."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 1000
    });

    const punctuatedText = response.choices[0].message.content.trim();
    console.log('Punctuation added successfully:', punctuatedText.substring(0, 100) + '...');
    
    return punctuatedText;

  } catch (error) {
    console.error('Error adding punctuation to text:', error);
    throw new Error(`Punctuation addition failed: ${error.message}`);
  }
}

/**
 * Applies punctuation to transcript segments
 * @param {Array} transcripts - Array of transcript objects with transcript, startTime, endTime, etc.
 * @param {string} language - Language code (optional, for better accuracy)
 * @returns {Promise<Array>} Array of transcript objects with punctuated transcript text
 */
async function applyPunctuationToTranscripts(transcripts, language = 'auto') {
  if (!Array.isArray(transcripts) || transcripts.length === 0) {
    return [];
  }

  console.log(`Applying punctuation to ${transcripts.length} transcript segments in parallel batches...`);

  const punctuatedTranscripts = [];
  const batchSize = 4; // Process 4 transcripts per batch

  // Process transcripts in batches
  for (let i = 0; i < transcripts.length; i += batchSize) {
    const batch = transcripts.slice(i, i + batchSize);
    const batchIndex = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(transcripts.length / batchSize);
    
    console.log(`Processing batch ${batchIndex}/${totalBatches} with ${batch.length} transcripts...`);
    
    // Process current batch in parallel
    const batchPromises = batch.map(async (transcript, batchOffset) => {
      const globalIndex = i + batchOffset;
      
      if (!transcript.transcript || typeof transcript.transcript !== 'string') {
        console.warn(`Skipping transcript at index ${globalIndex}: missing or invalid transcript text`);
        return transcript;
      }

      try {
        console.log(`Processing transcript ${globalIndex + 1}/${transcripts.length} in batch ${batchIndex}...`);
        
        // Add punctuation to the transcript text
        const punctuatedText = await addPunctuationToText(transcript.transcript, language);
        
        // Create new transcript object with punctuated text
        const punctuatedTranscript = {
          ...transcript,
          transcript: punctuatedText,
          originalTranscript: transcript.transcript // Keep original for reference
        };
        
        return punctuatedTranscript;
        
      } catch (error) {
        console.error(`Failed to add punctuation to transcript ${globalIndex + 1}:`, error);
        // Keep original transcript if punctuation fails
        return transcript;
      }
    });
    
    // Wait for current batch to complete
    const batchResults = await Promise.all(batchPromises);
    punctuatedTranscripts.push(...batchResults);
    
    console.log(`Completed batch ${batchIndex}/${totalBatches}`);
  }

  console.log(`Successfully processed ${punctuatedTranscripts.length} transcript segments in parallel batches`);
  return punctuatedTranscripts;
}

/**
 * Analyzes the importance score of individual sentences based on relevance to video description and topic
 * @param {Array} sentences - Array of sentence objects with transcript, startTime, endTime
 * @param {string} videoDescription - Description of the video
 * @param {string} mainTopic - Main topic of the video
 * @param {string} category - News category of the video
 * @returns {Promise<Array>} Array of sentence objects with importance scores
 */
async function analyzeSentenceImportance(sentences, videoDescription, mainTopic, category) {
  if (!Array.isArray(sentences) || sentences.length === 0) {
    return [];
  }

  console.log(`Analyzing importance scores for ${sentences.length} sentences...`);

  const sentencesWithImportance = [];

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    
    if (!sentence.transcript || typeof sentence.transcript !== 'string') {
      console.warn(`Skipping sentence at index ${i}: missing or invalid transcript text`);
      sentencesWithImportance.push({
        ...sentence,
        importanceScore: 0
      });
      continue;
    }

    try {
      console.log(`Processing sentence ${i + 1}/${sentences.length}...`);
      
      const prompt = `Evaluate this sentence to find out how important and relevant is the info this sentence provides about the video.

Video Context:
- Main Topic: "${mainTopic}"
- Category: "${category}"
- Description: "${videoDescription || 'No description provided'}"

Sentence to analyze: "${sentence.transcript}"

Return result as JSON in this format:
{
  "importanceScore": 0-100,
  "reasoning": "Brief explanation of why this score was given"
}
`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are an expert content analyst. Evaluate sentence importance based on relevance to video topic and description.This information will be used for summarizing the video to keep important info only."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 200
      });

      const text = response.choices[0].message.content;
      
      try {
        const result = parseOpenAIResponse(text);
        
        // Validate the importance score
        let importanceScore = result.importanceScore;
        if (typeof importanceScore !== 'number' || importanceScore < 0 || importanceScore > 100) {
          console.warn(`Invalid importance score for sentence ${i + 1}, using fallback score`);
          importanceScore = 50; // Default fallback score
        }
        
        sentencesWithImportance.push({
          ...sentence,
          importanceScore: Math.round(importanceScore),
          importanceReasoning: result.reasoning || "No reasoning provided"
        });
        
      } catch (parseError) {
        console.error(`Failed to parse OpenAI response for sentence ${i + 1}:`, text);
        // Fallback: assign a default score based on basic relevance check
        const fallbackScore = sentence.transcript.toLowerCase().includes(mainTopic.toLowerCase()) ? 60 : 30;
        sentencesWithImportance.push({
          ...sentence,
          importanceScore: fallbackScore,
          importanceReasoning: "Fallback score due to parsing error"
        });
      }
      
    } catch (error) {
      console.error(`Failed to analyze importance for sentence ${i + 1}:`, error);
      // Keep original sentence with default score if analysis fails
      sentencesWithImportance.push({
        ...sentence,
        importanceScore: 50,
        importanceReasoning: "Analysis failed"
      });
    }
  }

  console.log(`Successfully analyzed importance scores for ${sentencesWithImportance.length} sentences`);
  return sentencesWithImportance;
}

/**
 * Analyzes sentences for news worthiness and returns which ones should be kept in a summarized version
 * @param {Array} sentences - Array of sentence objects with transcript, startTime, endTime
 * @param {string} videoDescription - Description of the video for context
 * @param {string} mainTopic - Main topic of the video
 * @param {string} category - Category of the video
 * @returns {Array} Array of sentence objects with isImportant boolean added
 */
async function analyzeSentencesForNewsWorthiness(sentences, videoDescription, mainTopic, category) {
  if (!Array.isArray(sentences) || sentences.length === 0) {
    return [];
  }

  console.log(`Analyzing news worthiness for ${sentences.length} sentences...`);

  // If there are too many sentences, process them in chunks to avoid token limits
  const CHUNK_SIZE = 20; // Process 20 sentences at a time
  const allResults = [];

  for (let i = 0; i < sentences.length; i += CHUNK_SIZE) {
    const chunk = sentences.slice(i, i + CHUNK_SIZE);
    console.log(`Processing chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(sentences.length / CHUNK_SIZE)} (${chunk.length} sentences)`);
    
    const chunkResults = await analyzeSentencesChunk(chunk, videoDescription, mainTopic, category);
    allResults.push(...chunkResults);
  }

  console.log(`Successfully analyzed news worthiness for all ${allResults.length} sentences`);
  return allResults;
}

async function analyzeSentencesChunk(sentences, videoDescription, mainTopic, category) {
  // Extract all transcripts into a single text for batch analysis
  const allTranscripts = sentences.map(sentence => sentence.transcript).join('\n');
  const systemPrompt=`You are a news editor analyzing video transcripts to determine which sentences contain the most newsworthy information that should be kept in a short/summarized version of the news.`
  
  try {
    const prompt = `Determine which sentences contain the  most important and newsworthy information that should be kept in a short/summarized version of the news.

Video Context:
- Main Topic: "${mainTopic}"
- Category: "${category}"
- Description: "${videoDescription || 'No description provided'}"

All Transcripts to analyze:
${allTranscripts}

Return the result as JSON in this exact format:
{
  "sentences": [
    {
      "transcript": "exact transcript text",
      "isImportant": true/false,
      "reasoning": "brief explanation of why this sentence is important or not"
    }
  ]
}

IMPORTANT: 
- Match each transcript exactly as provided
- Return isImportant as true only for sentences that contain the most important and newsworthy information
- Keep the reasoning concise but clear
- Ensure all sentences from the input are included in the response`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 4000
    });

    const text = response.choices[0].message.content;
    
    try {
      const result = parseOpenAIResponse(text);
      
      if (!result.sentences || !Array.isArray(result.sentences)) {
        console.error('Invalid response structure:', result);
        console.error('Raw response text:', text);
        throw new Error('Invalid response structure: missing sentences array');
      }

      // Create a map of transcript to analysis result for quick lookup
      const analysisMap = new Map();
      result.sentences.forEach(item => {
        if (item.transcript && typeof item.isImportant === 'boolean') {
          analysisMap.set(item.transcript, {
            isImportant: item.isImportant,
            reasoning: item.reasoning || "No reasoning provided"
          });
        }
      });

      // Apply the analysis to each sentence
      const sentencesWithImportance = sentences.map(sentence => {
        const analysis = analysisMap.get(sentence.transcript);
        
        if (analysis) {
          return {
            ...sentence,
            isImportant: analysis.isImportant,
            importanceReasoning: analysis.reasoning
          };
        } else {
          // Fallback if transcript not found in analysis
          console.warn(`Transcript not found in analysis: "${sentence.transcript.substring(0, 50)}..."`);
          return {
            ...sentence,
            isImportant: false,
            importanceReasoning: "Not found in analysis - defaulting to false"
          };
        }
      });

      return sentencesWithImportance;
      
    } catch (parseError) {
      console.error('Failed to parse OpenAI response for news worthiness analysis:', parseError);
      console.error('Raw response length:', text.length);
      console.error('Raw response preview:', text.substring(0, 500) + '...');
      
      // Check if response was truncated
      if (text.includes('"sentences": [') && !text.includes(']')) {
        console.error('Response appears to be truncated - JSON incomplete');
      }
      
      // Fallback: assign default values based on basic relevance check
      const sentencesWithImportance = sentences.map(sentence => {
        const isRelevant = sentence.transcript.toLowerCase().includes(mainTopic.toLowerCase()) ||
                          (videoDescription && sentence.transcript.toLowerCase().includes(videoDescription.toLowerCase()));
        
        return {
          ...sentence,
          isImportant: isRelevant,
          importanceReasoning: `Fallback analysis: ${isRelevant ? 'Contains relevant keywords' : 'No relevant keywords found'}`
        };
      });
      
      return sentencesWithImportance;
    }
    
  } catch (error) {
    console.error('Failed to analyze news worthiness:', error);
    
    // Return sentences with default values if analysis fails
    const sentencesWithImportance = sentences.map(sentence => ({
      ...sentence,
      isImportant: false,
      importanceReasoning: "Analysis failed - defaulting to false"
    }));
    
    return sentencesWithImportance;
  }
}

/**
 * Adds words array to each sentence based on timestamp matching
 * @param {Array} sentences - Array of sentence objects with transcript, startTime, endTime
 * @param {Array} wordsList - Array of word objects with word, startTime, endTime
 * @returns {Array} Array of sentence objects with added words array
 */
function addWordsToSentences(sentences, wordsList) {
  if (!Array.isArray(sentences) || sentences.length === 0) {
    return [];
  }

  if (!Array.isArray(wordsList) || wordsList.length === 0) {
    console.warn('No words list provided, returning sentences without words array');
    return sentences.map(sentence => ({
      ...sentence,
      words: []
    }));
  }

  console.log(`Adding words to ${sentences.length} sentences...`);

  const sentencesWithWords = sentences.map(sentence => {
    const sentenceStartTime = parseFloat(sentence.startTime);
    const sentenceEndTime = parseFloat(sentence.endTime);

    // Find words that fall within this sentence's time range
    const sentenceWords = wordsList.filter(word => {
      const wordStartTime = parseFloat(word.startTime);
      const wordEndTime = parseFloat(word.endTime);
      
      // Check if word overlaps with sentence time range
      return (wordStartTime >= sentenceStartTime && wordStartTime <= sentenceEndTime) ||
             (wordEndTime >= sentenceStartTime && wordEndTime <= sentenceEndTime) ||
             (wordStartTime <= sentenceStartTime && wordEndTime >= sentenceEndTime);
    });

    // Sort words by start time to ensure proper order
    sentenceWords.sort((a, b) => parseFloat(a.startTime) - parseFloat(b.startTime));

    return {
      ...sentence,
      words: sentenceWords
    };
  });

  console.log(`Successfully added words to ${sentencesWithWords.length} sentences`);
  return sentencesWithWords;
}

/**
 * Creates subtitle chunks from sentences by breaking them into 10-12 word segments
 * @param {Array} sentences - Array of sentence objects with transcript, startTime, endTime, words array
 * @returns {Array} Array of subtitle chunk objects with transcript, startTime, endTime (mapped to 0+)
 */
// function createSubtitleChunks(sentences) {
//   if (!Array.isArray(sentences) || sentences.length === 0) {
//     return [];
//   }

//   console.log(`Creating subtitle chunks from ${sentences.length} sentences...`);

//   const subtitleChunks = [];
//   let previousEndTime=0;
//   let currentStartTime=0;
//   let currentTimeOffset = 0; // Tracks the mapped time starting from 0

//   for (const sentence of sentences) {
//     const sentenceStartTime = parseFloat(sentence.startTime);
//     const sentenceEndTime = parseFloat(sentence.endTime);
    
//     // Use the words array that's already present in the sentence object
//     let sentenceWords = sentence.words || [];

//     if (sentenceWords.length === 0) {
//       // If no words found, create a single chunk for the sentence
//       const chunkDuration = sentenceEndTime - sentenceStartTime;
//       subtitleChunks.push({
//         transcript: sentence.transcript,
//         startTime: currentTimeOffset,
//         endTime: currentTimeOffset + chunkDuration,
//         originalStartTime: sentenceStartTime,
//         originalEndTime: sentenceEndTime,
//         wordCount: sentence.transcript.split(' ').length
//       });
//       currentTimeOffset += chunkDuration;
//       continue;
//     }

//     const sentenceText = sentence.transcript;
//     const words = sentenceText.split(' ').filter(word => word.trim().length > 0);
    
//     const chunks = [];
//     const chunkSize = 11; // Target 11 words per chunk
    
//     for (let i = 0; i < words.length; i += chunkSize) {
//       const chunkWords = words.slice(i, i + chunkSize);
//       chunks.push(chunkWords.join(' '));
//     }

//     // Match each chunk to corresponding words
//     let wordIndex = 0;
    
//     for (const chunkText of chunks) {
//       const chunkWordCount = chunkText.split(' ').length;
      
//       // Find the next set of words that match this chunk
//       const chunkWords = [];
//       let wordsFound = 0;
      
//       while (wordIndex < sentenceWords.length && wordsFound < chunkWordCount) {
//         chunkWords.push(sentenceWords[wordIndex]);
//         wordsFound++;
//         wordIndex++;
//       }

//       if (chunkWords.length === 0) {
//         // Fallback: use estimated duration based on word count
//         const estimatedDuration = chunkWordCount * 0.5; // Assume 0.5 seconds per word
//         subtitleChunks.push({
//           transcript: chunkText,
//           startTime: currentTimeOffset,
//           endTime: currentTimeOffset + estimatedDuration,
//           originalStartTime: sentenceStartTime,
//           originalEndTime: sentenceEndTime,
//           wordCount: chunkWordCount
//         });
//         currentTimeOffset += estimatedDuration;

//         continue;
//       }

//       // Calculate chunk timestamps from the words
//       const chunkStartTime = parseFloat(chunkWords[0].startTime);
//       const chunkEndTime = parseFloat(chunkWords[chunkWords.length - 1].endTime);
//       const chunkDuration = chunkEndTime - chunkStartTime;
//       if(previousEndTime>0){
//         currentTimeOffset+=chunkStartTime-previousEndTime;
//       }

//       // Map to sequential time starting from 0
//       subtitleChunks.push({
//         transcript: chunkText,
//         startTime: currentTimeOffset,
//         endTime: currentTimeOffset + chunkDuration,
//         originalStartTime: chunkStartTime,
//         originalEndTime: chunkEndTime,
//         wordCount: chunkWordCount
//       });
//       previousEndTime=chunkEndTime;
//       currentTimeOffset += chunkDuration;
//     }
//   }

//   console.log(`Created ${subtitleChunks.length} subtitle chunks`);
//   return subtitleChunks;
// }

function createSubtitleChunks(mergedGroups) {
  if (!Array.isArray(mergedGroups) || mergedGroups.length === 0) {
    return [];
  }

  console.log(`Creating subtitle chunks from ${mergedGroups.length} merged groups...`);

  const subtitleChunks = [];
  let currentTimeOffset = 0; // Tracks the mapped time starting from 0

  for (const group of mergedGroups) {
    if (!Array.isArray(group) || group.length === 0) {
      continue;
    }

    // Reset previousEndTime to 0 for each new group
    let previousEndTime = 0;

    // Process each transcript in the group
    for (const sentence of group) {
      const sentenceStartTime = parseFloat(sentence.startTime);
      const sentenceEndTime = parseFloat(sentence.endTime);
      
      // Use the words array that's already present in the sentence object
      let sentenceWords = sentence.words || [];

      if (sentenceWords.length === 0) {
        // If no words found, create a single chunk for the sentence
        const chunkDuration = sentenceEndTime - sentenceStartTime;
        subtitleChunks.push({
          transcript: sentence.transcript,
          startTime: currentTimeOffset,
          endTime: currentTimeOffset + chunkDuration,
          originalStartTime: sentenceStartTime,
          originalEndTime: sentenceEndTime,
          wordCount: sentence.transcript.split(' ').length
        });
        currentTimeOffset += chunkDuration;
        continue;
      }

      const sentenceText = sentence.transcript;
      const words = sentenceText.split(' ').filter(word => word.trim().length > 0);
      
      const chunks = [];
      const chunkSize = 11; // Target 11 words per chunk
      
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunkWords = words.slice(i, i + chunkSize);
        chunks.push(chunkWords.join(' '));
      }

      // Match each chunk to corresponding words
      let wordIndex = 0;
      
      for (const chunkText of chunks) {
        const chunkWordCount = chunkText.split(' ').length;
        
        // Find the next set of words that match this chunk
        const chunkWords = [];
        let wordsFound = 0;
        
        while (wordIndex < sentenceWords.length && wordsFound < chunkWordCount) {
          chunkWords.push(sentenceWords[wordIndex]);
          wordsFound++;
          wordIndex++;
        }

        if (chunkWords.length === 0) {
          // Fallback: use estimated duration based on word count
          const estimatedDuration = chunkWordCount * 0.5; // Assume 0.5 seconds per word
          subtitleChunks.push({
            transcript: chunkText,
            startTime: currentTimeOffset,
            endTime: currentTimeOffset + estimatedDuration,
            originalStartTime: sentenceStartTime,
            originalEndTime: sentenceEndTime,
            wordCount: chunkWordCount
          });
          currentTimeOffset += estimatedDuration;
          continue;
        }

        // Calculate chunk timestamps from the words
        const chunkStartTime = parseFloat(chunkWords[0].startTime);
        const chunkEndTime = parseFloat(chunkWords[chunkWords.length - 1].endTime);
        const chunkDuration = chunkEndTime - chunkStartTime;
        
        // Add gap from previous chunk within the same group
        if (previousEndTime > 0) {
          currentTimeOffset += chunkStartTime - previousEndTime;
        }

        // Map to sequential time starting from 0
        subtitleChunks.push({
          transcript: chunkText,
          startTime: currentTimeOffset,
          endTime: currentTimeOffset + chunkDuration,
          originalStartTime: chunkStartTime,
          originalEndTime: chunkEndTime,
          wordCount: chunkWordCount
        });
        
        previousEndTime = chunkEndTime;
        currentTimeOffset += chunkDuration;
      }
    }
  }

  console.log(`Created ${subtitleChunks.length} subtitle chunks`);
  return subtitleChunks;
}
/**
 * Creates subtitle chunks with more precise word matching
 * @param {Array} sentences - Array of sentence objects with transcript, startTime, endTime
 * @param {Array} wordsList - Array of word objects with word, startTime, endTime
 * @returns {Array} Array of subtitle chunk objects with transcript, startTime, endTime (mapped to 0+)
 */
function createSubtitleChunksWithPreciseMatching(sentences, wordsList) {
  if (!Array.isArray(sentences) || sentences.length === 0) {
    return [];
  }

  if (!Array.isArray(wordsList) || wordsList.length === 0) {
    console.warn('No words list provided, returning original sentences as chunks');
    return sentences.map((sentence, index) => ({
      transcript: sentence.transcript,
      startTime: index * 5,
      endTime: (index + 1) * 5,
      originalStartTime: sentence.startTime,
      originalEndTime: sentence.endTime
    }));
  }

  console.log(`Creating subtitle chunks with precise matching from ${sentences.length} sentences...`);

  const subtitleChunks = [];
  let currentTimeOffset = 0;

  for (const sentence of sentences) {
    const sentenceStartTime = parseFloat(sentence.startTime);
    const sentenceEndTime = parseFloat(sentence.endTime);

    // Find words within sentence time range
    const sentenceWords = wordsList.filter(word => {
      const wordStartTime = parseFloat(word.startTime);
      const wordEndTime = parseFloat(word.endTime);
      
      return (wordStartTime >= sentenceStartTime && wordStartTime <= sentenceEndTime) ||
             (wordEndTime >= sentenceStartTime && wordEndTime <= sentenceEndTime) ||
             (wordStartTime <= sentenceStartTime && wordEndTime >= sentenceEndTime);
    });

    if (sentenceWords.length === 0) {
      // Fallback for sentences without matching words
      const chunkDuration = sentenceEndTime - sentenceStartTime;
      subtitleChunks.push({
        transcript: sentence.transcript,
        startTime: currentTimeOffset,
        endTime: currentTimeOffset + chunkDuration,
        originalStartTime: sentenceStartTime,
        originalEndTime: sentenceEndTime,
        wordCount: sentence.transcript.split(' ').length
      });
      currentTimeOffset += chunkDuration;
      continue;
    }

    // Sort words by start time
    sentenceWords.sort((a, b) => parseFloat(a.startTime) - parseFloat(b.startTime));

    // Break sentence into chunks of 10-12 words
    const sentenceText = sentence.transcript;
    const words = sentenceText.split(' ').filter(word => word.trim().length > 0);
    
    const chunks = [];
    const chunkSize = 11; // Target 11 words per chunk
    
    for (let i = 0; i < words.length; i += chunkSize) {
      const chunkWords = words.slice(i, i + chunkSize);
      chunks.push(chunkWords.join(' '));
    }

    // Match each chunk to corresponding words
    let wordIndex = 0;
    
    for (const chunkText of chunks) {
      const chunkWordCount = chunkText.split(' ').length;
      
      // Find the next set of words that match this chunk
      const chunkWords = [];
      let wordsFound = 0;
      
      while (wordIndex < sentenceWords.length && wordsFound < chunkWordCount) {
        chunkWords.push(sentenceWords[wordIndex]);
        wordsFound++;
        wordIndex++;
      }

      if (chunkWords.length === 0) {
        // Fallback: use estimated duration
        const estimatedDuration = chunkWordCount * 0.5;
        subtitleChunks.push({
          transcript: chunkText,
          startTime: currentTimeOffset,
          endTime: currentTimeOffset + estimatedDuration,
          originalStartTime: sentenceStartTime,
          originalEndTime: sentenceEndTime,
          wordCount: chunkWordCount
        });
        currentTimeOffset += estimatedDuration;
        continue;
      }

      // Calculate timestamps from matched words
      const chunkStartTime = parseFloat(chunkWords[0].startTime);
      const chunkEndTime = parseFloat(chunkWords[chunkWords.length - 1].endTime);
      const chunkDuration = chunkEndTime - chunkStartTime;

      subtitleChunks.push({
        transcript: chunkText,
        startTime: currentTimeOffset,
        endTime: currentTimeOffset + chunkDuration,
        originalStartTime: chunkStartTime,
        originalEndTime: chunkEndTime,
        wordCount: chunkWordCount
      });

      currentTimeOffset += chunkDuration;
    }
  }

  console.log(`Created ${subtitleChunks.length} subtitle chunks with precise matching`);
  return subtitleChunks;
}


function extractLastWordTimestamps(mergedGroups) {
  if (!mergedGroups || !Array.isArray(mergedGroups) || mergedGroups.length === 0) {
    return [];
  }

  return mergedGroups
    .filter(group => Array.isArray(group) && group.length > 0)
    .map(group => {
      const lastTranscript = group[group.length - 1];
      
      if (!lastTranscript.words || !Array.isArray(lastTranscript.words) || lastTranscript.words.length === 0) {
        return null;
      }
      
      const lastWord = lastTranscript.words[lastTranscript.words.length - 1];
      return {
        word: lastWord.word,
        startTime: lastWord.startTime,
        endTime: lastWord.endTime
      };
    })
    .filter(word => word !== null);
}

/**
 * Groups important sentences into meaningful chunks of 20-30 seconds
 * @param {Array} importantSentences - Array of sentence objects with transcript, startTime, endTime, isImportant
 * @param {string} videoDescription - Description of the video for context
 * @param {string} mainTopic - Main topic of the video
 * @param {string} category - Category of the video
 * @returns {Promise<Array>} Array of grouped sentence chunks
 */
async function createMeaningfulChunks(importantSentences, videoDescription, mainTopic, category) {
  if (!Array.isArray(importantSentences) || importantSentences.length === 0) {
    return [];
  }

  console.log(`Creating meaningful chunks from ${importantSentences.length} important sentences...`);

  // Sort sentences by startTime to ensure chronological order
  const sortedSentences = [...importantSentences].sort((a, b) => 
    parseFloat(a.startTime) - parseFloat(b.startTime)
  );

  // Prepare sentences data for OpenAI
  const sentencesData = sortedSentences.map((sentence, index) => ({
    id: index + 1,
    transcript: sentence.transcript,
    startTime: parseFloat(sentence.startTime),
    endTime: parseFloat(sentence.endTime),
    duration: parseFloat(sentence.endTime) - parseFloat(sentence.startTime)
  }));

  try {
    const prompt = `Group these sentences into logical, coherent chunks that are 20-30 seconds long (give or take 5 seconds) and that can be used independently as a news segment.
IMPORTANT: Each chunks MUST be AT MOST 30 seconds long. 
Video Context:
- Main Topic: "${mainTopic}"
- Category: "${category}"
- Description: "${videoDescription || 'No description provided'}"

Important Sentences to group:
${sentencesData.map(s => `ID ${s.id}: "${s.transcript}" (${s.startTime}s - ${s.endTime}s, duration: ${s.duration.toFixed(1)}s)`).join('\n')}

Requirements:
1. Create chunks that are 20-30 seconds long.
2. Sentences within each chunk should be logically connected and meaningful together
3. Respect the chronological order of sentences
4. Each chunk should tell a complete thought or story segment
NOTE: Thats not necessary to include all the sentences in the chunks. Include only those sentences that result in a chunks that can be used independently.
Return the result as JSON in this exact format:
{
  "chunks": [
    {
      "chunkId": 1,
      "sentences": [1, 3, 5], // IDs of sentences in this chunk
      "startTime": 12.5, // Start time of first sentence
      "endTime": 37.8, // End time of last sentence
      "summary": "Brief description of what this chunk covers"
    }
  ]
}

IMPORTANT:
- Use sentence IDs (not the full transcript text) in the sentences array
- Make sure chunks are meaningful and coherent
- Keep chunks within the 20-30 second target (15-35 seconds acceptable)`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are an expert video editor who creates meaningful, coherent content chunks from transcript sentences. You focus on grouping the sentences into logical, coherent chunks that are 20-30 seconds long (give or take 5 seconds)."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 3000
    });

    const text = response.choices[0].message.content;
    
    try {
      const result = parseOpenAIResponse(text);
      
      if (!result.chunks || !Array.isArray(result.chunks)) {
        throw new Error('Invalid response structure: missing chunks array');
      }

      // Convert the AI response into actual sentence groups
      const groupedChunks = result.chunks.map(chunk => {
        // Get the actual sentence objects for this chunk
        const chunkSentences = chunk.sentences.map(sentenceId => {
          const sentence = sortedSentences.find(s => 
            sortedSentences.indexOf(s) + 1 === sentenceId
          );
          return sentence;
        }).filter(sentence => sentence); // Remove any undefined sentences

        if (chunkSentences.length === 0) {
          console.warn(`No sentences found for chunk ${chunk.chunkId}`);
          return null;
        }

        // Calculate total duration by summing individual sentence durations
        let actualDuration = chunkSentences.reduce((total, sentence) => {
          const sentenceDuration = parseFloat(sentence.endTime) - parseFloat(sentence.startTime);
          return total + sentenceDuration;
        }, 0);

        // If actualDuration > 30, remove sentences from the end until duration <= 30
        while (actualDuration > 30 && chunkSentences.length > 1) {
          const lastSentence = chunkSentences.pop();
          actualDuration -= (parseFloat(lastSentence.endTime) - parseFloat(lastSentence.startTime));
        }

        const actualStartTime = Math.min(...chunkSentences.map(s => parseFloat(s.startTime)));
        const actualEndTime = Math.max(...chunkSentences.map(s => parseFloat(s.endTime)));

        return {
          chunkId: chunk.chunkId,
          sentences: chunkSentences,
          totalDuration: actualDuration,
          startTime: actualStartTime,
          endTime: actualEndTime,
          summary: chunk.summary || "No summary provided",
          transcript: chunkSentences.map(s => s.transcript).join(' ')
        };
      }).filter(chunk => chunk !== null); // Remove null chunks

      console.log(`Successfully created ${groupedChunks.length} meaningful chunks`);
      
      // Log chunk details for debugging
      groupedChunks.forEach(chunk => {
        console.log(`Chunk ${chunk.chunkId}: ${chunk.totalDuration.toFixed(1)}s (${chunk.sentences.length} sentences) - ${chunk.summary}`);
      });

      return groupedChunks;
      
    } catch (parseError) {
      console.error('Failed to parse OpenAI response for chunk creation:', parseError);
      console.error('Raw response:', text);
      
      // Fallback: create simple chunks based on time proximity
      return createFallbackChunks(sortedSentences);
    }
    
  } catch (error) {
    console.error('Failed to create meaningful chunks:', error);
    
    // Fallback: create simple chunks based on time proximity
    return createFallbackChunks(sortedSentences);
  }
}

/**
 * Fallback function to create chunks when AI analysis fails
 * @param {Array} sortedSentences - Array of sentences sorted by startTime
 * @returns {Array} Array of grouped chunks
 */
function createFallbackChunks(sortedSentences) {
  console.log('Using fallback chunk creation method...');
  
  const chunks = [];
  let currentChunk = [];
  let currentDuration = 0;
  const targetDuration = 25; // Target 25 seconds
  const maxDuration = 35; // Maximum 35 seconds
  
  for (const sentence of sortedSentences) {
    const sentenceDuration = parseFloat(sentence.endTime) - parseFloat(sentence.startTime);
    
    // If adding this sentence would exceed max duration, start a new chunk
    if (currentDuration + sentenceDuration > maxDuration && currentChunk.length > 0) {
      // Finalize current chunk
      const chunkStartTime = parseFloat(currentChunk[0].startTime);
      const chunkEndTime = parseFloat(currentChunk[currentChunk.length - 1].endTime);
      
      chunks.push({
        chunkId: chunks.length + 1,
        sentences: [...currentChunk],
        totalDuration: chunkEndTime - chunkStartTime,
        startTime: chunkStartTime,
        endTime: chunkEndTime,
        summary: `Fallback chunk ${chunks.length + 1}`,
        transcript: currentChunk.map(s => s.transcript).join(' ')
      });
      
      // Start new chunk
      currentChunk = [sentence];
      currentDuration = sentenceDuration;
    } else {
      // Add to current chunk
      currentChunk.push(sentence);
      currentDuration += sentenceDuration;
    }
  }
  
  // Add the last chunk if it has content
  if (currentChunk.length > 0) {
    const chunkStartTime = parseFloat(currentChunk[0].startTime);
    const chunkEndTime = parseFloat(currentChunk[currentChunk.length - 1].endTime);
    
    chunks.push({
      chunkId: chunks.length + 1,
      sentences: [...currentChunk],
      totalDuration: currentDuration, // Use the accumulated duration
      startTime: chunkStartTime,
      endTime: chunkEndTime,
      summary: `Fallback chunk ${chunks.length + 1}`,
      transcript: currentChunk.map(s => s.transcript).join(' ')
    });
  }
  
  console.log(`Created ${chunks.length} fallback chunks`);
  return chunks;
}

/**
 * Creates highlight chunks by combining highlights sequentially based on duration constraints
 * @param {Array} highlights - Array of highlight objects with start, end, highlightSummary properties
 * @returns {Array} Array of grouped highlight chunks
 */
function createHighlightChunksByDuration(highlights) {
  if (!Array.isArray(highlights) || highlights.length === 0) {
    return [];
  }

  console.log(`Creating highlight chunks by duration from ${highlights.length} highlights...`);

  // Sort highlights by start time to ensure chronological order
  const sortedHighlights = [...highlights].sort((a, b) => 
    parseFloat(a.start) - parseFloat(b.start)
  );

  const chunks = [];
  let currentChunk = [];
  let currentDuration = 0;
  const minDuration = 10; // Minimum 15 seconds
  const targetDuration = 20; // Target 20 seconds
  const maxDuration = 30; // Maximum 30 seconds

  // Add first highlight to first chunk by default
  if (sortedHighlights.length > 0) {
    const firstHighlight = sortedHighlights[0];
    currentChunk = [firstHighlight];
    currentDuration = parseFloat(firstHighlight.end) - parseFloat(firstHighlight.start);
  }

  // Process remaining highlights starting from index 1
  for (let i = 1; i < sortedHighlights.length; i++) {
    const highlight = sortedHighlights[i];
    const highlightDuration = parseFloat(highlight.end) - parseFloat(highlight.start);

    // Check if current chunk has reached target duration BEFORE adding new highlight
    if (currentDuration >= targetDuration && currentChunk.length > 0) {
      // Finalize current chunk
      const chunkStartTime = parseFloat(currentChunk[0].start);
      const chunkEndTime = parseFloat(currentChunk[currentChunk.length - 1].end);
      
      chunks.push({
        chunkId: chunks.length + 1,
        highlights: [...currentChunk],
        totalDuration: currentDuration, // Use the calculated currentDuration
        startTime: chunkStartTime,
        endTime: chunkEndTime,
        summary: `Chunk ${chunks.length + 1}: ${currentChunk.length} highlights combined`,
        highlightSummaries: currentChunk.map(h => h.highlightSummary).join(' ')
      });
      
      // Start new chunk with current highlight
      currentChunk = [highlight];
      currentDuration = highlightDuration;
    }
    // Check if adding this highlight would exceed max duration BEFORE adding it
    else if (currentDuration + highlightDuration > maxDuration && currentChunk.length > 0) {
      // Finalize current chunk if it meets minimum duration
      if (currentDuration >= minDuration) {
        const chunkStartTime = parseFloat(currentChunk[0].start);
        const chunkEndTime = parseFloat(currentChunk[currentChunk.length - 1].end);
        
        chunks.push({
          chunkId: chunks.length + 1,
          highlights: [...currentChunk],
          totalDuration: currentDuration, // Use the calculated currentDuration
          startTime: chunkStartTime,
          endTime: chunkEndTime,
          summary: `Chunk ${chunks.length + 1}: ${currentChunk.length} highlights combined`,
          highlightSummaries: currentChunk.map(h => h.highlightSummary).join(' ')
        });
      }
      
      // Start new chunk with current highlight
      currentChunk = [highlight];
      currentDuration = highlightDuration;
    } else {
      // Add to current chunk
      currentChunk.push(highlight);
      currentDuration += highlightDuration;
    }
  }

  // Handle the last chunk if it has content
  if (currentChunk.length > 0) {
    const chunkStartTime = parseFloat(currentChunk[0].start);
    const chunkEndTime = parseFloat(currentChunk[currentChunk.length - 1].end);
    
    // Only add if it meets minimum duration or it's the only chunk
    if (currentDuration >= minDuration || chunks.length === 0) {
      chunks.push({
        chunkId: chunks.length + 1,
        highlights: [...currentChunk],
        totalDuration: currentDuration, // Use the calculated currentDuration
        startTime: chunkStartTime,
        endTime: chunkEndTime,
        summary: `Chunk ${chunks.length + 1}: ${currentChunk.length} highlights combined`,
        highlightSummaries: currentChunk.map(h => h.highlightSummary).join(' ')
      });
    }
  }

  console.log(`Created ${chunks.length} highlight chunks by duration`);
  
  // Log chunk details for debugging
  chunks.forEach(chunk => {
    console.log(`Duration Chunk ${chunk.chunkId}: ${chunk.totalDuration.toFixed(1)}s (${chunk.highlights.length} highlights) - ${chunk.summary}`);
  });

  return chunks;
}

module.exports = {
  parseOpenAIResponse,
  analyzeMainTopic,
  groupRelatedTranscripts,
  mergeCloseTranscripts,
  findRelevantShotsForTranscripts,
  analyzeSpeakerPresenceForRelevantGroup,
  breakDownRelevantTranscriptsIntoSentences,
  divideTranscriptsIntoSentencesWithAI,
  addPunctuationToText,
  applyPunctuationToTranscripts,
  analyzeSentenceImportance,
  analyzeSentencesForNewsWorthiness,
  createMeaningfulChunks,
  addWordsToSentences,
  createSubtitleChunks,
  createSubtitleChunksWithPreciseMatching,
  extractLastWordTimestamps,
  createMeaningfulChunks,
  createHighlightChunksByDuration,
};
