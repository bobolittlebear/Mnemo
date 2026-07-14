// src/controllers/embedding.controller.ts
import { Request, Response } from 'express';
import { createLogger } from '@/lib/logger';
import ApiResponse from '@/utils/apiResponse';
import { UNKNOWN_ERROR } from '@/utils/constant';
import { generateEmbeddings } from '@/lib/embedding';
const logger = createLogger('api');

/**
 * PUT /stream/embedding
 * 生成向量化数据
 */
const createVector = async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
        const text = req.body?.text || [];
        const vectors = await generateEmbeddings(text);
        res.json(ApiResponse.success({ vectors }));
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

export { createVector };
