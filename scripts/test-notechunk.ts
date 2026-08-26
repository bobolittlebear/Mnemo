/**
 * 笔记内容分块工具函数测试
 * 运行: npx ts-node -r tsconfig-paths/register scripts/test-notechunk.ts
 */
import dotenv from 'dotenv';
// 加载 .env 中的 AI_API_KEY / MONGODB_URI / EMBEDDING_DIMENSIONS
dotenv.config({
    path: `.env.${process.env.NODE_ENV || 'development'}`,
});
import { chunkMarkdown } from '../src/utils/noteChunker';
// 无标题文本
const nonHeaderCase =
    '🐛 useAutoSave设置了5秒防抖delay，在delay期间编辑后立即切换笔记或者离开页面，未主动保存笔记导致编辑内容丢失\n\n---\n\n**根因**（已在代码里坐实，`useAutoSave.ts`）： \n\n1. **切换笔记丢内容**：`NoteEditorPane` 用 `key={noteId}` 重建，切换时旧组件卸载。但防抖保存是「编辑后等 5 秒才 `updateNote`」。组件卸载只触发了 `abortControllerRef.current?.abort()`（取消正在进行的**请求**），**并没有 flush 那个还没到点的 5 秒定时器**——`use-debounce` 在组件卸载时会清掉 pending timer，于是 5 秒内的编辑既没进定时器、也没进后端，**直接蒸发**。\n\n2. **离开页面丢内容**：`beforeunload` 只在 `status === "saving"`（已开始保存）时才拦。但防抖等待中的状态还是 `idle`，关页面根本不拦；就算拦了，也只是弹确认框让用户离开，pending 的计时器随之销毁，内容照样没存。\n\n**修法**：在 `useAutoSave` 内部加「兜底 flush」闭环——组件卸载（切换笔记）、页面切走（`visibilitychange`/`pagehide`）时，把最新内容**立即**保存；`beforeunload` 改成「有未保存改动就提示」。全部封装在 hook 内，`NoteEditorPane`/父组件都不用动。\n\n```\n  // 镜像最新 content/title，供 beforeunload / flush 等闭包外场景读取\n  const latest = useRef({ content, title });\n  useEffect(() => {\n    latest.current = { content, title };\n  }, [content, title]);\n\n  // 组件是否已挂载：unmount 后跳过 setState，避免对已卸载组件更新告警\n  const mountedRef = useRef(true);\n```\n\n```typescript\n  // 生命周期兜底：切换笔记（组件卸载）/ 页面切走或卸载时，把尚未触发的保存立即 flush\n  useEffect(() => {\n    const onHide = () => {\n      if (document.visibilityState === "hidden") flush();\n    };\n    const onPageHide = () => flush();\n    document.addEventListener("visibilitychange", onHide);\n    window.addEventListener("pagehide", onPageHide);\n    return () => {\n      // 先标记已卸载，使 flush 触发的 saveNow 跳过对已卸载组件的 setState\n      mountedRef.current = false;\n      // 切换笔记时组件卸载 → 把 5 秒内未完成的防抖保存立即发出，避免内容丢失\n      flush();\n      document.removeEventListener("visibilitychange", onHide);\n      window.removeEventListener("pagehide", onPageHide);\n    };\n  }, [flush]);\n```';

const goldenCase1 =
    '## 📌 今日知识点：Redis 分布式锁\n\n### 一、基础概念：它解决什么问题\n\n单机时代一把 `mutex`（进程内互斥锁）就够了——因为只有一个进程在跑。但服务一上多实例（Node 集群、K8s 多副本），每个实例各自持有自己的锁，\\*\\*互不感知\\*\\*，两个实例可能同时执行同一段代码（比如扣库存、跑定时任务）。\n\n分布式锁 = 一把所有实例都认的锁，保证「同一时刻只有一个实例能拿到」。\n\nRedis 能当锁的原因：\\*\\*单线程执行命令\\*\\*，天然原子，多个客户端同时 SET 只有一个能成功——这就是互斥的本质。\n\n### 二、三代演进：为什么不能照抄网上老代码\n\n#### **v1 ·** `SETNX` **+** `EXPIRE`**（两个命令）**\n\n```\nSETNX lock:order 1     # 抢锁\nEXPIRE lock:order 30   # 设过期防死锁\n```\n\n坑：两步不原子。第一步成功、第二步前进程崩了 → 锁永不过期 → \\*\\*死锁\\*\\*。\n\n#### v2 · `SET lock:order 1 NX EX 30`（一条命令）\n\nSET 的 `NX`（不存在才设置）+ `EX`（过期时间）合成单命令，原子性解决，锁会自动过期。\n\n新坑：\\*\\*误删他人锁\\*\\*。A 的业务跑了 40s 超过 30s 锁过期了，B 抢到锁；A 执行完执行 `DEL`，把 B 的锁删了 → 两个实例同时进入临界区，锁形同虚设。\n\n#### v3 · 唯一标识 + Lua 脚本（生产可用版）\n\n```\n# value 存唯一随机标识（如 UUID），删除前先比对，防止误删\n\nif redis.call("get", KEYS[1]) == ARGV[1] then\n\n  return redis.call("del", KEYS[1])\n\nelse\n\n  return 0\n\nend\n```\n\n「判断 + 删除」两步也在 Lua 里原子执行，比对通过才删。**这是面试手写题的满分答案。**\n\n### 三、进阶追问（面试高频）\n\n- **锁过期了业务还没跑完怎么办？** → 看门狗（Watchdog）：Redisson 等客户端会自动续期，业务没结束锁就不会过期；业务结束主动释放。\n- **主从切换丢锁怎么办？** → Redlock：向 N 个独立 Redis 节点都加锁，过半成功才算拿到。争议很大（存在时钟漂移等理论缺陷），国内多数场景单节点 + 看门狗够用，别为了装逼引入复杂度。\n- **还有别的实现吗？** → ZooKeeper / etcd 的临时顺序节点锁（强一致，适合对一致性要求极高的场景），以及 MySQL 悲观锁 `SELECT ... FOR UPDATE`。\n\n### 四、应用场景 & 和你 Mnemo 的关联\n\n- 秒杀/库存扣减：防止超卖\n- **定时任务：多实例部署时保证\\*\\*只有一个实例\\*\\*执行（比如每天凌晨的记忆压缩任务）**\n- **防重复提交 / 幂等控制：同一条消息只处理一次**\n\n落到 Mnemo 上：你当前是单实例，如果以后多实例部署，\\*\\*L2 记忆提取、定时归档这类任务\\*\\*就得靠分布式锁抢执行权，避免重复提取同一批消息产生重复记忆。另外你之前学过的缓存三大难题里「击穿」的解法——互斥锁，本质也是这个。\n\n---\n\n**一句话记住**：`SETNX` 是玩具，`SET NX EX` 能防死锁，\\*\\*唯一标识 + Lua 原子校验\\*\\*才是生产级，再加看门狗续期防业务超时。';

// 还要测试无格式纯文本，但带了一、二、等中文标题的文本，看看效果
console.log(chunkMarkdown(goldenCase1));
