import type { ImageGenResult } from "./index";

export async function generateStabilityImage(
  prompt: string
): Promise<ImageGenResult> {
  const apiKey = process.env.STABILITY_API_KEY;
  if (!apiKey) throw new Error("Missing STABILITY_API_KEY");

  const formData = new FormData();
  formData.append("prompt", prompt);
  formData.append("model", "sd3.5-large");
  formData.append("output_format", "png");

  const response = await fetch(
    "https://api.stability.ai/v2beta/stable-image/generate/sd3",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown error");
    throw new Error(`Stability API error (${response.status}): ${errText}`);
  }

  const json = (await response.json()) as { image?: string };
  if (!json.image) {
    throw new Error("Stability API returned no image data");
  }

  return {
    url: `data:image/png;base64,${json.image}`,
    size: "1024x1024",
  };
}
