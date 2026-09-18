/**
 * V1 写作模式工具定义（Function Calling schema）
 *
 * 对应设计：.claude/design/tool-calling/tool-calling-detail.md §5 工具协议
 *
 * 本文件只定义 schema 并导出，供写作模式注入 ai.chat.completions.create 的 tools 字段。
 * 不含任何调用 / 解析 / 路由 / 装配逻辑（属 M-B1 / M-C1 / M-C3）。
 *
 * 两点边界不在本文件表达：
 * - 单轮最多一个 tool_call：Function Calling 无法在 schema 层强制，由 M-C1 执行循环校验；
 * - 光标 / 选区上下文（§5.1 docHashAtSend / selection / cursorContext）随消息上行的
 *   请求体顶层字段传递，不走工具参数。
 */
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';

/**
 * 三工具定义。
 *
 * 标注为 ChatCompletionFunctionTool[] 而非 ChatCompletionTool[]：
 * 后者是 function | custom 的联合，取 .function 需先收窄；
 * 本数组全部为 function 工具，用具体成员类型可直接注入 create 的 tools 字段（数组协变）。
 */
export const chatTools: ChatCompletionFunctionTool[] = [
    {
        type: 'function',
        function: {
            name: 'update_title',
            description:
                '整标题替换：把笔记标题整体改成 new_title。只动标题，不改正文；' +
                '用户要补充或修改正文时请改用 insert_at_cursor 或 replace_selection。',
            parameters: {
                type: 'object',
                properties: {
                    new_title: {
                        type: 'string',
                        description: '整标题替换后的新标题',
                    },
                },
                required: ['new_title'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'insert_at_cursor',
            description:
                '在消息发送时快照的光标位置插入 Markdown 文本。' +
                '空文档时即纯插入；已有正文时只做追加或局部补充，' +
                '永不静默全文覆盖——确需改写全文请改用 replace_selection。',
            parameters: {
                type: 'object',
                properties: {
                    markdown: {
                        type: 'string',
                        description:
                            '在消息发送时快照的光标位置插入的 Markdown 文本；已有正文永不静默全文覆盖',
                    },
                },
                required: ['markdown'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'replace_selection',
            description:
                '用 Markdown 文本替换消息发送时快照的用户选区。' +
                '仅当上下文带有选区时可用；无选区时应改走对话澄清或 insert_at_cursor，' +
                '不要凭空替换用户没有选中的内容。',
            parameters: {
                type: 'object',
                properties: {
                    markdown: {
                        type: 'string',
                        description:
                            '替换消息发送时快照的用户选区的 Markdown 文本；无选区时模型应改走对话澄清或 insert_at_cursor',
                    },
                },
                required: ['markdown'],
                additionalProperties: false,
            },
        },
    },
];
