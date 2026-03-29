// Language codes supported by Google Cloud Video Intelligence API
const SUPPORTED_LANGUAGES = [
  // English variants
  'en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN',
  
  // Spanish variants
  'es-ES', 'es-MX', 'es-AR', 'es-CL', 'es-CO', 'es-PE',
  
  // French variants
  'fr-FR', 'fr-CA', 'fr-BE', 'fr-CH',
  
  // German variants
  'de-DE', 'de-AT', 'de-CH',
  
  // Italian variants
  'it-IT', 'it-CH',
  
  // Portuguese variants
  'pt-BR', 'pt-PT',
  
  // Asian languages
  'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW', 'zh-HK', 'ru-RU',
  
  // Arabic variants
  'ar-SA', 'ar-EG', 'ar-MA', 'ar-DZ', 'ar-TN',
  
  // Indian languages
  'hi-IN', 'bn-IN', 'ta-IN', 'te-IN',
  
  // Other languages
  'tr-TR', 'nl-NL', 'nl-BE', 'pl-PL', 'sv-SE', 'da-DK',
  'fi-FI', 'no-NO', 'cs-CZ', 'hu-HU', 'el-GR', 'he-IL',
  'id-ID', 'ms-MY', 'th-TH', 'vi-VN', 'uk-UA', 'ro-RO',
  'bg-BG', 'hr-HR', 'sk-SK', 'sl-SI', 'et-EE', 'lv-LV',
  'lt-LT', 'fa-IR', 'ur-PK'
];

// Language names mapping
const LANGUAGE_NAMES = {
  // English variants
  'en-us': 'English (US)',
  'en-gb': 'English (UK)',
  'en-au': 'English (Australia)',
  'en-ca': 'English (Canada)',
  'en-in': 'English (India)',
  
  // Spanish variants
  'es-es': 'Spanish (Spain)',
  'es-mx': 'Spanish (Mexico)',
  'es-ar': 'Spanish (Argentina)',
  'es-cl': 'Spanish (Chile)',
  'es-co': 'Spanish (Colombia)',
  'es-pe': 'Spanish (Peru)',
  'es-uy': 'Spanish (Uruguay)',
  'es-us': 'Spanish (United States)',
  
  // French variants
  'fr-fr': 'French (France)',
  'fr-ca': 'French (Canada)',
  'fr-be': 'French (Belgium)',
  'fr-ch': 'French (Switzerland)',
  
  // German variants
  'de-de': 'German (Germany)',
  'de-at': 'German (Austria)',
  'de-ch': 'German (Switzerland)',
  
  // Italian variants
  'it-it': 'Italian (Italy)',
  'it-ch': 'Italian (Switzerland)',
  
  // Portuguese variants
  'pt-br': 'Portuguese (Brazil)',
  'pt-pt': 'Portuguese (Portugal)',
  
  // Asian languages
  'ja-jp': 'Japanese (Japan)',
  'ko-kr': 'Korean (South Korea)',
  'zh-cn': 'Chinese (Simplified)',
  'zh-tw': 'Chinese (Traditional)',
  'zh-hk': 'Chinese (Hong Kong)',
  'ru-ru': 'Russian (Russia)',
  
  // Arabic variants
  'ar-sa': 'Arabic (Saudi Arabia)',
  'ar-eg': 'Arabic (Egypt)',
  'ar-ma': 'Arabic (Morocco)',
  'ar-dz': 'Arabic (Algeria)',
  'ar-tn': 'Arabic (Tunisia)',
  
  // Indian languages
  'hi-in': 'Hindi (India)',
  'bn-in': 'Bengali (India)',
  'ta-in': 'Tamil (India)',
  'te-in': 'Telugu (India)',
  
  // Other languages
  'tr-tr': 'Turkish (Turkey)',
  'nl-nl': 'Dutch (Netherlands)',
  'nl-be': 'Dutch (Belgium)',
  'pl-pl': 'Polish (Poland)',
  'sv-se': 'Swedish (Sweden)',
  'da-dk': 'Danish (Denmark)',
  'fi-fi': 'Finnish (Finland)',
  'no-no': 'Norwegian (Norway)',
  'cs-cz': 'Czech (Czech Republic)',
  'hu-hu': 'Hungarian (Hungary)',
  'el-gr': 'Greek (Greece)',
  'he-il': 'Hebrew (Israel)',
  'id-id': 'Indonesian (Indonesia)',
  'ms-my': 'Malay (Malaysia)',
  'th-th': 'Thai (Thailand)',
  'vi-vn': 'Vietnamese (Vietnam)',
  'uk-ua': 'Ukrainian (Ukraine)',
  'ro-ro': 'Romanian (Romania)',
  'bg-bg': 'Bulgarian (Bulgaria)',
  'hr-hr': 'Croatian (Croatia)',
  'sk-sk': 'Slovak (Slovakia)',
  'sl-si': 'Slovenian (Slovenia)',
  'et-ee': 'Estonian (Estonia)',
  'lv-lv': 'Latvian (Latvia)',
  'lt-lt': 'Lithuanian (Lithuania)',
  'fa-ir': 'Persian (Iran)',
  'ur-pk': 'Urdu (Pakistan)',
  'unknown': 'Unknown'
};

// Helper function to get language name from code
function getLanguageName(code) {
  return LANGUAGE_NAMES[code] || 'Unknown Language';
}

module.exports = {
  SUPPORTED_LANGUAGES,
  LANGUAGE_NAMES,
  getLanguageName
}; 