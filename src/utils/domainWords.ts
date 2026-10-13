// src/utils/domainWords.ts
// Mnemo 领域词典：供 jieba 自定义分词注册，避免专有名词（模块名 / 字段名 / 内部黑话）
// 被默认词表切碎，导致 BM25 倒排索引两侧碎片对不上而漏召回。
//
// 由 src/utils/tokenizer.ts 在模块加载时一次性注册——入库（NoteChunk.searchText）与
// 查询（noteSearch tokenize(query)）共用同一出口，一处注册两侧自动一致。
//
// 【M1 结论：手写词典已证伪，词表置空】
// 同一语料 + 同一 query 集的三份报告对照：无词典 BM25 macro@5 = 0.611 >
// 裁记忆族 = 0.600 > 全量词典 = 0.578。复合词被「保住」的同时必然吃掉其组成词
// （jieba 整句 DP 重排周边分词），对仍用组成词的 query 是净损失，本语料上无一例改善。
// 详见 tests/evals/reports/2026-10-13_m1-{dict,nodict,pruned}.md。
//
// 保留模块与 tokenizer 的注册机制（空数组 = 不调 add_word，零运行时开销），
// 供 M2（query-expansion 等）复用。
export const DOMAIN_WORDS: readonly string[] = [];
