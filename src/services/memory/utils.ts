import { RawMessage } from '@/types/chat';
import { RawFact } from '@/types/memory';
import { EXTRACTION_PROMPT } from '@/utils/constant';
import { formatDateTime } from '@/utils/tool';

/** prompt变量替换 */
export function replacePromptVariables(
    prompt: string,
    variables: Record<string, string>,
): string {
    let replacedPrompt = prompt;
    for (const [key, value] of Object.entries(variables)) {
        const placeholder = `{{${key}}}`;
        replacedPrompt = replacedPrompt.replace(
            new RegExp(placeholder, 'g'),
            value,
        );
    }
    return replacedPrompt;
}
// 示例用法
// const conversationText = '用户在准备前端面试，重点复习 React 和 TypeScript';
// const existingMemories = '用户在杭州，有 3 年前端经验';
// const promptWithVariables = replacePromptVariables(EXTRACTION_PROMPT, {
//     USER_ID: 'czs',
//     CONVERSATION: conversationText,
//     CONVERSATION_TIME_RANGE: '2026-07-14T08:17:56.793Z - 2026-07-14T08:32:03.865Z',
//     EXISTING_MEMORIES: existingMemories,
// });

export function replaceExtractionPromptVariables(
    variables: {
        USER_ID: string;
        CONVERSATION: string;
        CONVERSATION_TIME_RANGE: string;
        EXISTING_MEMORIES: string;
    },
    prompt: string = EXTRACTION_PROMPT,
): string {
    return replacePromptVariables(prompt, variables);
}

export function getMessagesTimeRangeText(messages: RawMessage[]) {
    if (!messages) return '';
    const start = formatDateTime(
        new Date(messages[0]?.timestamp ?? Date.now()),
    );
    if (messages.length === 1) {
        return `${start} - ${start}`;
    }
    const lastIdx = messages.length - 1;
    const end = formatDateTime(
        new Date(messages[lastIdx]?.timestamp ?? Date.now()),
    );
    return `${start} - ${end}`;
}

export function formatConversationText(messages: RawMessage[]): string {
    return (
        messages
            ?.map((m) => `[msg_id:${m.msgId}] ${m.role}: ${m.content}`)
            ?.join('\n') ?? ''
    );
}

export function formatExistingMemoriesText(facts: RawFact[]): string {
    return facts
        .map(
            (f, index) =>
                `${index}.[sourceMessageIds: ${f.sourceMessageIds.join(',')}](${f.category})[confidence: ${f.confidence}]${f.content}`,
        )
        .join(';');
}
