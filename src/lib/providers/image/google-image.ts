import { GoogleGenAI } from "@google/genai";
import type { ImageGenResult } from "./index";

// Map ADE model IDs to actual Google API model names
const MODEL_MAP: Record<string, string> = {
  "imagen-4": "imagen-4.0-generate-001",
  // Legacy fallback in case ADE still sends imagen-3
  "imagen-3": "imagen-4.0-generate-001",
};

export async function generateGoogleImage(
  modelId: string,
  prompt: string
): Promise<ImageGenResult> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Missing GOOGLE_API_KEY");

  const ai = new GoogleGenAI({ apiKey });
  const apiModel = MODEL_MAP[modelId] ?? "imagen-4.0-generate-001";

  const response = await ai.models.generateImages({
    model: apiModel,
    prompt,
    config: { numberOfImages: 1 },
  });

  const generatedImages = response.generatedImages;
  if (!generatedImages || generatedImages.length === 0) {
    throw new Error("Imagen returned no images");
  }

  const imageBytes = generatedImages[0].image?.imageBytes;
  if (!imageBytes) {
    throw new Error("Imagen returned empty image data");
  }

  return {
    url: `data:image/png;base64,${imageBytes}`,
    size: "1024x1024",
  };
}
