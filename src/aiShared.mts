import {AIMessageChunk} from "@langchain/core/messages";

export function contentToString(res: AIMessageChunk): string {
  if (typeof res.content === "string") {
    return res.content;
  } else if (Array.isArray(res.content)) {
    return res.content.map(c => ((c as any).text ?? "")).join("\n");
  }

  return (res.content as any)?.text ?? "";
}

