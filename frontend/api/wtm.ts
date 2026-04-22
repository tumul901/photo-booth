import type { WordsPayload, ComposePayload, ComposeResult } from "@/types/wtm";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export async function fetchWords(templateId: string): Promise<WordsPayload> {
  const res = await fetch(`${API_BASE_URL}/api/wtm/words/${templateId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.message || "Failed to load words");
  }
  return res.json();
}

export async function composeTemplate(
  payload: ComposePayload,
): Promise<ComposeResult> {
  const res = await fetch(`${API_BASE_URL}/api/wtm/compose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.message || "Compose failed");
  }
  return res.json();
}
