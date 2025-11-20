import { GoogleGenAI } from "@google/genai";

let aiClient: GoogleGenAI | null = null;
let currentApiKey: string | null = null;

export const getGenAIClient = (apiKey?: string): GoogleGenAI => {
  const keyToUse = apiKey || process.env.API_KEY;
  
  if (!keyToUse) {
    throw new Error("API_KEY is not set. Please configure it in settings.");
  }

  // Re-initialize if key changes or client doesn't exist
  if (!aiClient || currentApiKey !== keyToUse) {
    aiClient = new GoogleGenAI({ apiKey: keyToUse });
    currentApiKey = keyToUse;
  }
  
  return aiClient;
};