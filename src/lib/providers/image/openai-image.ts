import OpenAI from "openai";
import type { ImageGenResult } from "./index";

export async function generateOpenAIImage(prompt: string): Promise<ImageGenResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const client = new OpenAI({ apiKey });

  const result = await client.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "standard",
    style: "vivid",
    response_format: "url",
  });

  const url = result.data?.[0]?.url;
  if (!url) throw new Error("DALL-E 3 returned no image URL");

  return { url, size: "1024x1024", style: "vivid" };
}
