import { requestDisplayText } from "./util.js";

interface UpdateRequest<Image> { prompt: string; images: readonly Image[] }

/** Split a queued batch by the actual composed prompt size, preserving FIFO order. */
export function mergeUpdateBatch<Image, Entry extends UpdateRequest<Image>>(batch: readonly Entry[], maxPromptChars: number): {
  prompt: string; display: string | undefined; images: Image[]; overflow: Entry[];
} {
  if (!Number.isSafeInteger(maxPromptChars) || maxPromptChars < 1) throw new Error("Invalid prompt limit.");
  const first = batch[0];
  if (!first) throw new Error("Cannot merge an empty update batch.");
  if (first.prompt.length > maxPromptChars) throw new Error("Queued request exceeds the prompt limit.");
  const requests = [first.prompt];
  const images = [...first.images];
  let prompt = first.prompt;
  let consumed = 1;
  for (const entry of batch.slice(1)) {
    const candidate = composeMergedPrompt([...requests, entry.prompt]);
    if (candidate.length > maxPromptChars) break;
    prompt = candidate;
    requests.push(entry.prompt);
    images.push(...entry.images);
    consumed += 1;
  }
  return { prompt, display: requests.length > 1 ? requestDisplayText(requests) : undefined, images, overflow: batch.slice(consumed) };
}

function composeMergedPrompt(requests: readonly string[]): string {
  const rest = requests.slice(1);
  if (!rest.length) return requests[0]!;
  return `${requests[0]}\n\nWhile updates were queued, the user sent ${rest.length} more message${rest.length === 1 ? "" : "s"}: apply all of them in this same pass:\n${rest.map((prompt, index) => `${index + 2}. ${prompt}`).join("\n")}`;
}
