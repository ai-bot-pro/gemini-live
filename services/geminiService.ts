import { GoogleGenAI } from "@google/genai";

let aiClient: GoogleGenAI | null = null;
let currentApiKey: string | null = null;

export const getGenAIClient = (apiKey?: string): GoogleGenAI => {
  const keyToUse = apiKey || process.env.API_KEY;
  
  if (!keyToUse) {
    throw new Error("Credentials are not set. Please configure API Key or Token in settings.");
  }

  // Re-initialize if key changes or client doesn't exist.
  // This ensures we switch between API Key and Ephemeral Token if the user updates settings.
  if (!aiClient || currentApiKey !== keyToUse) {
    aiClient = new GoogleGenAI({ apiKey: keyToUse });
    currentApiKey = keyToUse;
  }
  
  return aiClient;
};