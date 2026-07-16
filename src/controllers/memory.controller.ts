// src/controllers/embedding.controller.ts
import { Request, Response } from 'express';
import { createLogger } from '@/lib/logger';
import ApiResponse from '@/utils/apiResponse';
import { UNKNOWN_ERROR } from '@/utils/constant';
import memoryExtractionService from '@/services/memory/memoryExtraction.service';
import type { RawMessage } from '@/types/chat';
import memoryPipelineService from '@/services/memory/memoryPipeline.service';
import { getUserIdFromMemoryKey } from '@/utils/tool';
const logger = createLogger('api');

/**
 * PUT /stream/fact/extract
 * 从消息中提取记忆
 */
const extractFacts = async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
        const messages: RawMessage[] = req.body?.messages || [];

        if (!messages.length) return res.json(ApiResponse.success([]));

        logger.info('/fact/extract', {
            length: messages.length,
        });

        const facts = await memoryExtractionService.extractFacts(messages);
        res.json(ApiResponse.success({ facts }));
    } catch (error) {
        logger.error('向量化生成失败', {
            traceId: res.locals.traceId,
            duration_ms: Date.now() - startTime,
            error,
        });
        res.status(500).json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

/**
 * PUT /stream/fact/pipeline
 * 记忆入库
 */
const ingestFacts = async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
        const messages: RawMessage[] = req.body?.messages || [];

        if (!messages.length) return res.json(ApiResponse.success([]));

        logger.info('/fact/pipeline', {
            length: messages.length,
        });
        const memoryKey = req.cookies.memory_key;
        const userId = getUserIdFromMemoryKey(memoryKey);
        const facts = await memoryPipelineService.run(userId, messages);
        res.json(ApiResponse.success({ facts }));
    } catch (error) {
        logger.error('向量化生成失败', {
            traceId: res.locals.traceId,
            duration_ms: Date.now() - startTime,
            error,
        });
        res.status(500).json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

export { extractFacts, ingestFacts };
