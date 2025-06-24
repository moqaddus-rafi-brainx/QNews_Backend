const { OpenAI } = require('openai');
require('dotenv').config();
const axios = require('axios');
const { uploadAudioToCloudinary } = require('./cloudinaryUpload');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function convertTextToSpeech(text, voice) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/audio/speech',
        {
          model: "tts-1",
          input: text,
          voice: "alloy"
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer' 
        }
      );
  
      // Upload audio buffer to Cloudinary instead of saving locally
      const audioUrl = await uploadAudioToCloudinary(response.data, 'voiceovers');
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
    contentType = 'Transcript Content';
  }
  else {
    console.warn('⚠️ Unknown content format, using empty description');
    contentDescription = '';
  }

  const targetWordCount = Math.floor(duration * 2.3);
  
  
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
  
  return completion.choices[0].message.content.trim();
}

module.exports = {
  generateVoiceOver,
  convertTextToSpeech
};
