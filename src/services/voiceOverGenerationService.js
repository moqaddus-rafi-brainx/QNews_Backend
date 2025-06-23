const { OpenAI } = require('openai');
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const { uploadAudioToCloudinary } = require('./cloudinaryUpload');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Generates a voiceover script for a video using OpenAI
 * @param {string} summary - The summary of the video
 * @param {string} visualDescription - The visual description or shot/frame description
 * @param {number} duration - The desired duration of the voiceover in seconds
 * @returns {Promise<string>} - The generated voiceover script
 */
/*
async function generateVoiceOver(summary, shots, duration) {
    
    const visualDescription=shots.map(shot => shot.description).join('\n');
  console.log('Duration:',duration);
  //const prompt = `You are a professional summary text generator for voiceovers on videos. Write a compelling, natural-sounding voiceover script summarizing the video content.\n\nVideo Summary: ${summary}\nVisual Description: ${visualDescription}.Focus mainly on the summary and donot include scene descriptions.\n\nThe voiceover should match the visuals and be engaging for viewers. The total voiceover should be suitable for a video of about ${duration} seconds.\n\nRespond ONLY with the script, do not include any other text or explanation.`;
  const targetWordCount = Math.floor(duration * 2.2);
    
  console.log('Duration:', duration, 'Target word count:', targetWordCount);
    
    const prompt = `You are a professional transcript generator for voiceovers on summarized videos. Write a compelling, natural-sounding voiceover script summarizing the video content.

Video Summary: ${summary}
Visual Description: ${visualDescription}

IMPORTANT: The script must be EXACTLY ${targetWordCount} words (give or take 5 words). Focus mainly on the summary and do not include scene descriptions.
The total voiceover should be suitable for a video of about ${duration} seconds.

Respond ONLY with the script, do not include any other text or explanation.`;
  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: "You are a helpful assistant for video voiceover generation." },
      { role: "user", content: prompt }
    ],
    max_tokens: 300,
    temperature: 0.7
  });
  console.log('Voice Over:',completion.choices[0].message.content.trim());
  return completion.choices[0].message.content.trim();
}
  */

async function convertTextToSpeech(text, voice) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/audio/speech',
        {
          model: "tts-1", // or "tts-1-hd"
          input: text,
          voice: "alloy"
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer' // Needed to receive audio data
        }
      );
  
      // Upload audio buffer to Cloudinary instead of saving locally
      const audioUrl = await uploadAudioToCloudinary(response.data, 'voiceovers');
      console.log('✅ Audio uploaded to Cloudinary:', audioUrl);
      return audioUrl;
    } catch (error) {
      if (error.response?.data) {
        const errorText = Buffer.from(error.response.data).toString('utf-8');
        try {
          const errorJson = JSON.parse(errorText);
          console.error('❌ Error:', errorJson);
        } catch (parseErr) {
          console.error('❌ Error (non-JSON):', errorText);
        }
      } else {
        console.error('❌ Error:', error.message);
      }
      throw error; // Re-throw the error so calling function can handle it
    }
  }


  /**
 * Generates a voiceover script for a video using OpenAI
 * @param {string} summary - The summary of the video
 * @param {Array|Object} contentData - Either shots array or relevantContent object
 * @param {number} duration - The desired duration of the voiceover in seconds
 * @returns {Promise<string>} - The generated voiceover script
 */
async function generateVoiceOver(summary, contentData, duration) {
  let contentDescription = '';
  let contentType = '';
  
  // Check if contentData is shots array (original format)
  if (Array.isArray(contentData) && contentData.length > 0 && contentData[0].description) {
    // Handle shots format
    contentDescription = contentData.map(shot => shot.description).join('\n');
    console.log('📹 Using shots format for voiceover generation');
    contentType = 'Visual Description';
  } 
  // Check if contentData is directly a relevantContent array
  else if (Array.isArray(contentData) && contentData.length > 0 && contentData[0].transcripts) {
    // Handle direct relevantContent array format
    const transcriptTexts = [];
    
    // Iterate through each item in the array
    contentData.forEach(item => {
      if (item.transcripts && Array.isArray(item.transcripts)) {
        // Iterate through each transcript in the transcripts array
        item.transcripts.forEach(transcript => {
          if (transcript.transcript) {
            transcriptTexts.push(transcript.transcript);
          }
        });
      }
    });
    
    contentDescription = transcriptTexts.join('\n');
    console.log('📝 Using direct relevantContent format for voiceover generation');
    console.log(`📊 Found ${transcriptTexts.length} transcript segments`);
    contentType = 'Transcript Content';
  }
  else {
    console.warn('⚠️ Unknown content format, using empty description');
    console.log('🔍 ContentData type:', typeof contentData);
    console.log('🔍 ContentData structure:', JSON.stringify(contentData, null, 2).substring(0, 200) + '...');
    contentDescription = '';
  }

  console.log('Duration:', duration);
  const targetWordCount = Math.floor(duration * 2.3);
  console.log('Duration:', duration, 'Target word count:', targetWordCount);
  
  
  const prompt = `You are a professional transcript generator for voiceovers on summarized videos. Write a compelling, natural-sounding voiceover script summarizing the video content.

Video Summary: ${summary}
${contentType}: ${contentDescription}

IMPORTANT: The script must be EXACTLY ${targetWordCount} words (give or take 5 words). Focus mainly on the summary and transcript if its provided and do not include scene descriptions if its visual description.
The total voiceover should be suitable for a video of about ${duration} seconds.

Respond ONLY with the script, do not include any other text or explanation.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: "You are a helpful assistant for video voiceover generation." },
      { role: "user", content: prompt }
    ],
    max_tokens: 300,
    temperature: 0.7
  });
  
  console.log('Voice Over:', completion.choices[0].message.content.trim());
  return completion.choices[0].message.content.trim();
}

module.exports = {
  generateVoiceOver,
  convertTextToSpeech
};
