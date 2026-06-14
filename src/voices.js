// Voice catalogue, grouped for the UI.
//   engine: 'edge'  → Microsoft Edge neural voices via edge-tts (free, online)
//           'yarn'  → YarnGPT hosted Nigerian-language TTS (Yoruba/Igbo/Hausa)
//   lang:   the language Grok must WRITE the narration in (stock queries stay English)
//   yarnVoice: the YarnGPT speaker name to use when engine === 'yarn'

export const VOICES = {
  // Native-language neural voices — the script is written in that language.
  native: [
    { id: 'yarn-yor-f',          label: 'Yorùbá — Idera (F, melodic)',       gender: 'Female',  engine: 'yarn', yarnVoice: 'Idera',    locale: 'yo-NG', lang: 'Yoruba' },
    { id: 'yarn-yor-m',          label: 'Yorùbá — Femi (M, rich)',           gender: 'Male',    engine: 'yarn', yarnVoice: 'Femi',     locale: 'yo-NG', lang: 'Yoruba' },
    { id: 'yarn-ibo-f',          label: 'Igbo — Chinenye (F, warm)',         gender: 'Female',  engine: 'yarn', yarnVoice: 'Chinenye', locale: 'ig-NG', lang: 'Igbo' },
    { id: 'yarn-ibo-m',          label: 'Igbo — Nonso (M, bold)',            gender: 'Male',    engine: 'yarn', yarnVoice: 'Nonso',    locale: 'ig-NG', lang: 'Igbo' },
    { id: 'yarn-hau-f',          label: 'Hausa — Zainab (F, soothing)',      gender: 'Female',  engine: 'yarn', yarnVoice: 'Zainab',   locale: 'ha-NG', lang: 'Hausa' },
    { id: 'yarn-hau-m',          label: 'Hausa — Umar (M, calm)',            gender: 'Male',    engine: 'yarn', yarnVoice: 'Umar',     locale: 'ha-NG', lang: 'Hausa' },
    { id: 'sw-KE-ZuriNeural',    label: 'Zuri — Swahili (Kenya, F)',         gender: 'Female',  engine: 'edge', locale: 'sw-KE', lang: 'Swahili' },
    { id: 'sw-KE-RafikiNeural',  label: 'Rafiki — Swahili (Kenya, M)',       gender: 'Male',    engine: 'edge', locale: 'sw-KE', lang: 'Swahili' },
    { id: 'zu-ZA-ThandoNeural',  label: 'Thando — Zulu (South Africa, F)',   gender: 'Female',  engine: 'edge', locale: 'zu-ZA', lang: 'Zulu' },
    { id: 'am-ET-MekdesNeural',  label: 'Mekdes — Amharic (Ethiopia, F)',    gender: 'Female',  engine: 'edge', locale: 'am-ET', lang: 'Amharic' },
    { id: 'af-ZA-AdriNeural',    label: 'Adri — Afrikaans (South Africa, F)',gender: 'Female',  engine: 'edge', locale: 'af-ZA', lang: 'Afrikaans' },
    { id: 'so-SO-UbaxNeural',    label: 'Ubax — Somali (Somalia, F)',        gender: 'Female',  engine: 'edge', locale: 'so-SO', lang: 'Somali' },
  ],
  // Nigerian / African-accented English.
  africa: [
    { id: 'en-NG-AbeoNeural',    label: 'Abeo — Nigerian English (M)',     gender: 'Male',   engine: 'edge', locale: 'en-NG', lang: 'English' },
    { id: 'en-NG-EzinneNeural',  label: 'Ezinne — Nigerian English (F)',   gender: 'Female', engine: 'edge', locale: 'en-NG', lang: 'English' },
    { id: 'en-KE-ChilembaNeural',label: 'Chilemba — Kenyan English (M)',   gender: 'Male',   engine: 'edge', locale: 'en-KE', lang: 'English' },
    { id: 'en-KE-AsiliaNeural',  label: 'Asilia — Kenyan English (F)',     gender: 'Female', engine: 'edge', locale: 'en-KE', lang: 'English' },
    { id: 'en-ZA-LukeNeural',    label: 'Luke — South African English (M)',gender: 'Male',   engine: 'edge', locale: 'en-ZA', lang: 'English' },
    { id: 'en-ZA-LeahNeural',    label: 'Leah — South African English (F)',gender: 'Female', engine: 'edge', locale: 'en-ZA', lang: 'English' },
    { id: 'en-TZ-ElimuNeural',   label: 'Elimu — Tanzanian English (M)',   gender: 'Male',   engine: 'edge', locale: 'en-TZ', lang: 'English' },
    { id: 'en-TZ-ImaniNeural',   label: 'Imani — Tanzanian English (F)',   gender: 'Female', engine: 'edge', locale: 'en-TZ', lang: 'English' },
  ],
  global: [
    { id: 'en-US-AndrewNeural',  label: 'Andrew — US English (M, warm)',   gender: 'Male',   engine: 'edge', locale: 'en-US', lang: 'English' },
    { id: 'en-US-AvaNeural',     label: 'Ava — US English (F, natural)',   gender: 'Female', engine: 'edge', locale: 'en-US', lang: 'English' },
    { id: 'en-US-GuyNeural',     label: 'Guy — US English (M)',            gender: 'Male',   engine: 'edge', locale: 'en-US', lang: 'English' },
    { id: 'en-US-JennyNeural',   label: 'Jenny — US English (F)',          gender: 'Female', engine: 'edge', locale: 'en-US', lang: 'English' },
    { id: 'en-GB-RyanNeural',    label: 'Ryan — British English (M)',      gender: 'Male',   engine: 'edge', locale: 'en-GB', lang: 'English' },
    { id: 'en-GB-SoniaNeural',   label: 'Sonia — British English (F)',     gender: 'Female', engine: 'edge', locale: 'en-GB', lang: 'English' },
    { id: 'en-AU-WilliamNeural', label: 'William — Australian English (M)',gender: 'Male',   engine: 'edge', locale: 'en-AU', lang: 'English' },
    { id: 'en-IN-PrabhatNeural', label: 'Prabhat — Indian English (M)',    gender: 'Male',   engine: 'edge', locale: 'en-IN', lang: 'English' },
    { id: 'en-IN-NeerjaNeural',  label: 'Neerja — Indian English (F)',     gender: 'Female', engine: 'edge', locale: 'en-IN', lang: 'English' },
  ],
};

const ALL = [...VOICES.native, ...VOICES.africa, ...VOICES.global];

export function allVoiceIds() {
  return ALL.map((v) => v.id);
}

export function getVoice(id) {
  return ALL.find((v) => v.id === id) || null;
}

export function isValidVoice(id) {
  return ALL.some((v) => v.id === id);
}

export function defaultVoice(context) {
  return context === 'africa' ? 'en-NG-EzinneNeural' : 'en-US-AvaNeural';
}
