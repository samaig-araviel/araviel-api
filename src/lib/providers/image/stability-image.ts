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

  const json = (await response.json()) as { image?: string; artifacts?: Array<{ base64?: string }> };

  // v2beta returns { image: "<base64>" }; older endpoints used { artifacts: [{ base64 }] }
  const b64 = json.image ?? json.artifacts?.[0]?.base64;
  if (!b64) {
    throw new Error("Stability API returned no image data");
  }

  return {
    url: `data:image/png;base64,${b64}`,
    size: "1024x1024",
  };
}
