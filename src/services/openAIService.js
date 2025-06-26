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
 * Utility function to parse JSON from OpenAI responses that may be wrapped in markdown code blocks
 * @param {string} text - The response text from OpenAI
 * @returns {Object} - Parsed JSON object
 * @throws {Error} - If JSON parsing fails
 */
function parseOpenAIResponse(text) {
  // Handle responses wrapped in markdown code blocks
  let jsonText = text;
  
  // Remove markdown code block formatting if present
  if (text.includes('```json')) {
    jsonText = text.replace(/```json\s*/, '').replace(/\s*```/, '');
  } else if (text.includes('```')) {
    jsonText = text.replace(/```\s*/, '').replace(/\s*```/, '');
  }
  
  // Find the first JSON object
  const jsonStart = jsonText.indexOf('{');
  if (jsonStart === -1) {
    throw new Error('No JSON object found in response');
  }
  
  return JSON.parse(jsonText.slice(jsonStart));
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
  
  // Sort transcripts by start time
  const sortedTranscripts = [...transcripts].sort((a, b) => 
    parseFloat(a.startTime) - parseFloat(b.startTime)
  );
  
  const mergedGroups = [];
  let currentGroup = [sortedTranscripts[0]];
  
  for (let i = 1; i < sortedTranscripts.length; i++) {
    const current = sortedTranscripts[i];
    const lastInGroup = currentGroup[currentGroup.length - 1];
    
    // Check if current transcript is within 8 seconds of the last transcript in the group
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
  "relevanceScore": 0-100(how relevant and important is this segment to the main topic)
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
          relevanceScore: result.relevanceScore,
        });
      } else {
        irrelevantGroup.push({
          ...transcript,
          relevanceScore: result.relevanceScore,
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
  console.log('mergedContentWithVoiceType:',mergedContentWithVoiceType);
  
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
    relevantSentences=await divideTranscriptsIntoSentencesWithAI(relevantGroup,speechTranscripts);
    console.log('Relevant sentences:', relevantSentences);
    const result= selectMostRelevantShotsWithin30sGreedy(relevantSentences);
    selectedShots=result.selectedShots;
    totalDuration=result.totalDuration;

  }
  else{
    //Find shots that corresponds to the relevant transcripts
    const relevantShots=findRelevantShotsForTranscripts(relevantGroup,shots);
    const result= selectMostRelevantShotsWithin30sGreedy(relevantShots);
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
      return (speechStartTime <= relevantEndTime && speechEndTime >= relevantStartTime);
    });
    
    if (!matchingSpeechTranscript) {
      // If no matching speech transcript found, add the entire relevant transcript as one sentence
      sentences.push({
        transcript: relevantTranscript.transcript,
        startTime: relevantTranscript.startTime,
        endTime: relevantTranscript.endTime,
        relevanceScore: relevantTranscript.relevanceScore || 0
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
        relevanceScore: relevantTranscript.relevanceScore || 0
      });
      continue;
    }
    
    // Prepare the transcript text and words for AI analysis
    const transcriptText = relevantTranscript.transcript;
    const wordsWithTimestamps = relevantWords.map(word => ({
      word: word.word,
      startTime: word.startTime,
      endTime: word.endTime
    }));
    
    const prompt = `
You are a transcript analyzer. Your task is to divide the given transcript into natural sentences and provide the start and end times for each sentence.

Transcript: "${transcriptText}"

Available words with timestamps:
${wordsWithTimestamps.map(w => `"${w.word}" (${w.startTime}s - ${w.endTime}s)`).join('\n')}

Instructions:
1. Analyze the transcript and identify natural sentence boundaries
2. For each sentence, find the corresponding words from the available words list
3. Use the first word's startTime as the sentence's startTime
4. Use the last word's endTime as the sentence's endTime
5. Only use words that are actually present in the available words list

Return the result as JSON in this format:
{
  "sentences": [
    {
      "sentence": "The actual sentence text",
      "startTime": 12.5,
      "endTime": 15.2,
      "words": ["word1", "word2", "word3"]
    }
  ]
}

Important: Only include sentences that can be constructed from the available words. If the transcript cannot be properly divided into sentences, return the entire transcript as one sentence.
`;

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3
      });

      const text = response.choices[0].message.content;
      const result = parseOpenAIResponse(text);
      
      if (result.sentences && Array.isArray(result.sentences)) {
        // Add each sentence to the results
        result.sentences.forEach(sentenceData => {
          sentences.push({
            transcript: sentenceData.sentence,
            startTime: sentenceData.startTime,
            endTime: sentenceData.endTime,
            relevanceScore: relevantTranscript.relevanceScore || 0
          });
        });
      } else {
        // Fallback: add the entire transcript as one sentence
        sentences.push({
          transcript: relevantTranscript.transcript,
          startTime: relevantTranscript.startTime,
          endTime: relevantTranscript.endTime,
          relevanceScore: relevantTranscript.relevanceScore || 0
        });
      }
    } catch (error) {
      console.error("Failed to divide transcript into sentences with AI:", error);
      // Fallback: add the entire transcript as one sentence
      sentences.push({
        transcript: relevantTranscript.transcript,
        startTime: relevantTranscript.startTime,
        endTime: relevantTranscript.endTime,
        relevanceScore: relevantTranscript.relevanceScore || 0
      });
    }
  }
  
  return sentences;
}

module.exports = {
  analyzeMainTopic,
  groupRelatedTranscripts,
  mergeCloseTranscripts,
  findRelevantShotsForTranscripts,
  analyzeSpeakerPresenceForRelevantGroup,
  breakDownRelevantTranscriptsIntoSentences,
  divideTranscriptsIntoSentencesWithAI
};
