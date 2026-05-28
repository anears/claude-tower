import { z } from 'zod';

const TextContent = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const ToolUseContent = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

const ToolResultContent = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});

const ThinkingContent = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
});

const ContentBlock = z.union([TextContent, ToolUseContent, ToolResultContent, ThinkingContent]);

const UserMessage = z.object({
  type: z.literal('user'),
  uuid: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  message: z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(ContentBlock)]),
  }),
});

const AssistantMessage = z.object({
  type: z.literal('assistant'),
  uuid: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  message: z.object({
    role: z.literal('assistant'),
    model: z.string().optional(),
    content: z.array(ContentBlock),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
      })
      .optional(),
  }),
});

const SummaryMessage = z.object({
  type: z.literal('summary'),
  summary: z.string().optional(),
});

const SystemMessage = z.object({
  type: z.literal('system'),
  content: z.unknown().optional(),
  timestamp: z.string().optional(),
});

export const TranscriptEntry = z.union([UserMessage, AssistantMessage, SummaryMessage, SystemMessage]);

export type TranscriptEntry = z.infer<typeof TranscriptEntry>;
export type UserMessage = z.infer<typeof UserMessage>;
export type AssistantMessage = z.infer<typeof AssistantMessage>;
export type ContentBlock = z.infer<typeof ContentBlock>;

export interface SessionInfo {
  projectDir: string;
  cwd: string;
  gitBranch?: string;
  aiTitle?: string;
  sessionId: string;
  source: string; // server name whose filesystem hosts this session's JSONL
  filePath: string;
  lastModified: Date;
  sizeBytes: number;
  liveOn: string[]; // server names where this session is currently running
  status?: string; // busy / idle / running
  tmuxTarget?: string; // "<host>:<session>:<window>.<pane>" for send-keys, if live in tmux
}
